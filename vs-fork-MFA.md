# vs-fork: TOTP MFA + idle timeout

This document describes the vs-fork's MFA layer. It's the
operator-facing reference for the contract that closes the
**Plan 1 Task 6 hard gate** (AnythingLLM v1.12.1 ships neither
TOTP MFA nor session idle timeout — both are mandatory under
**spec §4.4**).

> The corresponding executable contract is
> `docs/plans/2026-04-30-plan-1.5-mfa-and-idle-timeout.md` in
> the plan repo.

---

## 1. Threat model decisions

| Decision | Choice | Rationale |
|---|---|---|
| TOTP cadence | Required on **every** login. No remember-me cookie. | Spec §4.4 ("MFA required on every login"); a single device-trust cookie defeats the purpose at COFA scale. |
| Step-up freshness | 5 minutes. Re-prompt for sensitive endpoints if the session's `last_step_up_at` is older. | Bounds the blast radius of an attacker who hijacks an active session. |
| Idle timeout | 15 minutes per session, **server-tracked** (client-side hint only). | Spec §4.4. Server is the source of truth — a tampered or replayed client clock can't extend a session. |
| Backup codes | 10 codes, bcrypt-hashed, single-use. | Standard NIST 800-63B fallback for a lost authenticator. Atomic consume (UPDATE … WHERE used_at IS NULL) prevents double-spend under concurrency. |
| TOTP replay | A successful TOTP counter is recorded per user; verifying the *same* counter twice is rejected. | Closes the cross-endpoint replay race (Codex v1.0 BLOCK #2). Implemented as a single compare-and-swap primitive `consumeTotpCounter()` shared by every TOTP-success path. |
| Challenge tokens | Single-use, server-side nonce table (`mfa_challenge_nonces`); JTI consumed atomically on use. | Stops a leaked challenge JWT being replayed across endpoints. |
| Lockout | 5 fails / 15-min window → 15-min lockout. 10 lockouts → 1-hour lockout. | Tiered to discourage brute force without locking out a butterfingered operator forever. |
| Session lifetime | 30 days hard ceiling, regardless of activity. | Belt-and-braces alongside idle timeout. Forces a fresh full-MFA login at least monthly. |

## 2. Trust boundary: the recovery audit log

`/Vault/governance/audit/recovery.log` is created with the
macOS `chflags uappnd` flag (set by the Plan 1 bootstrap;
Plan 1.5 Task 12.5 wires the bootstrap-extension formally).
`uappnd` makes the file append-only against every actor on
the box **except** the COFA themselves, who has shell access
and can `chflags nouappnd` before tampering.

This is acceptable because:
1. The COFA is the only person with audit-write responsibility
   under spec §4.4 — there is no second human to lie to.
2. Any retroactive tamper by the COFA is itself a
   regulator-reportable incident. The log is intended to be
   evidence *to* the regulator, not protection *from* the COFA.
3. The broader audit chain (Git-signed governance commits per
   recovery event; Plan 5's daily off-host audit-log shipment;
   the COLP's external review) provides defence-in-depth.

If stronger evidence is ever required, a future Plan 1.7 can
hash-chain `recovery.log` entries and require a separate
Git-signed governance commit per recovery event.

## 3. Schema additions

### users (new columns)

| Column | Type | Note |
|---|---|---|
| `totp_secret_ciphertext` | `String?` | Encrypted via `EncryptionManager` (`SIG_KEY` + `SIG_SALT` from env). Loss of `SIG_KEY` invalidates every secret — this is intentional and treated as part of the disaster-recovery key set under `governance/`. |
| `totp_verified_at` | `DateTime?` | Set by `/auth/mfa/enrol/confirm`. NULL means "enrolment incomplete" — middleware blocks all protected routes with `needs_enrolment`. |
| `totp_last_used_counter` | `BigInt?` | Last TOTP step used. Compare-and-swap target. |
| `mfa_failed_attempt_count` | `Int @default(0)` | Sliding window for rate limiter. |
| `mfa_failed_window_start` | `DateTime?` | Window anchor. |
| `mfa_lockout_until` | `DateTime?` | Hard lockout until this timestamp. |
| `must_rotate_password` | `Boolean @default(false)` | Set by recovery scripts; gated by `validatedRequest`. |

### New tables

- **`user_sessions`** — server-tracked sessions. Columns:
  `id` (ULID), `user_id`, `last_activity_at`, `last_step_up_at`,
  `revoked_at`, `revocation_reason`, `user_agent`, `remote_ip`,
  `created_at`, `expires_at`. Session JWTs carry the row's `id`
  in `jti`; auth middleware re-checks `revoked_at IS NULL` and
  the idle window every request.
- **`user_backup_codes`** — `code_hash` (bcrypt cost 10),
  `used_at`. Atomic single-use consume.
- **`mfa_attempt_log`** — append-only attempt outcomes for
  forensics: `success`, `fail_password`, `fail_totp`,
  `fail_replay`, `fail_locked_out`, `fail_no_user`. No PII
  beyond `user_id` (nullable) and `remote_ip`.
- **`mfa_challenge_nonces`** — `jti` (ULID), `aud`,
  `expires_at`, `consumed_at`. Single-use replay gate for
  `mfa-challenge` and `mfa-enrolment` JWTs.

## 4. Endpoints (mounted at `/api`)

All endpoints accept JSON; all return JSON. All non-public ones
go through `validatedRequest`.

| Method + path | Purpose | Auth gate |
|---|---|---|
| `POST /api/request-token` | Username + password → returns `challenge_token` (aud `mfa-challenge` if user is enrolled, `mfa-enrolment` if not). **No full session JWT issued here**. | Public. |
| `POST /api/auth/mfa/enrol` | Returns `{ otpauth_url, qr_data_uri }` for a pending secret. | Holds an `mfa-enrolment` challenge token. |
| `POST /api/auth/mfa/enrol/confirm` | Operator submits a TOTP code from their authenticator. On match: enrolment is committed, **10 backup codes are returned exactly once**, and a full session JWT is minted. | Holds an `mfa-enrolment` challenge token + valid TOTP. |
| `POST /api/auth/mfa/challenge` | Operator submits a TOTP code (or backup code). On match: full session JWT is minted; the challenge token's JTI is consumed. | Holds an `mfa-challenge` challenge token. |
| `POST /api/auth/mfa/step-up` | Re-prompt within an existing session (for a sensitive endpoint). Updates `user_sessions.last_step_up_at`. | Full session + valid TOTP. |
| `POST /api/auth/mfa/disable` | Operator disables their own MFA (e.g. before re-enrolling on a new device). Wipes secret + backup codes; **forces password rotation**. | Full session + step-up within 5 min. |
| `POST /api/auth/mfa/backup-codes/regenerate` | Issues a fresh batch of 10 backup codes; old codes wiped. | Full session + step-up within 5 min. |
| `POST /api/auth/mfa/sessions/revoke-all` | Revokes every session for the calling user (lost device, panic button). | Full session + step-up within 5 min. |

## 5. Middleware (Express layer)

- **`validatedRequest`** — multi-user path requires `aud=vs-declaration` JWT, an active `user_sessions` row, `totp_verified_at != NULL`, `must_rotate_password == false` (or path is `/api/system/update-password` / `/api/system/user`), and that the session has not idled past 15 minutes. On idle-out the session row is revoked with `reason=idle` and the response is `401 session_expired`. On every successful pass, `last_activity_at` is touched.
- **`idleTimeout`** — standalone exported helper exposing `SESSION_IDLE_MS = 15*60*1000`. Used by `validatedRequest` and available for any future endpoint that needs the same constant.
- **`requireFullAuth`** / **`requireFreshStepUp(maxMinutes)`** — Task 11 wires `requireFreshStepUp(5)` onto every sensitive endpoint (change-password, export-chats, enable-multi-user, the three MFA-mutation endpoints above).
- **`totpRateLimiter`** — 5 fails per 15-min window → 15-min lockout. 10th lockout in any 24-hour window escalates to 1-hour. Mounted in front of every TOTP-verifying endpoint.

## 6. Recovery flows (in order of preference)

1. **Lost phone, has backup codes** — operator uses one of the 10 backup codes at the next login challenge. After login, regenerates a fresh batch and re-enrols on a new device.
2. **Lost phone, lost backup codes, still authenticated on another tab** — `POST /api/auth/mfa/disable` (requires step-up). Operator re-enrols.
3. **Lost device, MFA secret itself believed safe** — operator with shell access runs:
   ```bash
   node server/scripts/revoke-user-sessions.js <user-id>
   ```
   All sessions revoked (`reason=lost_device`). `users.must_rotate_password = true`. **MFA secret + backup codes preserved** so the operator can complete the next-login TOTP challenge with the same authenticator app on a recovered device, then change password. Recovery event written to `recovery.log`.
4. **Total lockout** — operator with shell access runs:
   ```bash
   node server/scripts/disable-mfa.js <user-id>
   ```
   Wipes `totp_secret_ciphertext`, `totp_verified_at`, `totp_last_used_counter`; resets `mfa_failed_attempt_count` / `mfa_failed_window_start` / `mfa_lockout_until`; deletes all `user_backup_codes`; revokes all sessions (`reason=disable_mfa_recovery`); sets `must_rotate_password = true`. The next login forces re-enrolment **and** a password rotation. Recovery event written to `recovery.log`.

Both scripts require interactive `Type DELETE to confirm` and refuse to proceed otherwise. The non-interactive override `VS_RECOVERY_AUTOCONFIRM=1` exists for the test harness and is **not** documented in the operator runbook — the prompt is part of the safety contract.

## 7. Deviations from the plan

- **otplib pinned at `12.0.1`** (the plan first listed `13.x`). v13 ESM-only deps broke Jest. v12 sync class API is CJS-friendly; covered in commit `f01455ec`.
- **Prisma SQLite < 5.12 lacks `createMany`** — `UserBackupCode.seed` issues an array of `create()` calls inside a `$transaction` for atomicity. Covered in commit `f01455ec`.
- **Plan's `disable-mfa.js` pseudocode used `User.update`** — that method's `writable` filter would silently strip every MFA column. Both recovery scripts call `prisma.users.update` directly. Recorded in this doc.
- **Recovery-log path is env-overridable (`VS_RECOVERY_LOG_PATH`)** — production default unchanged at `/Vault/governance/audit/recovery.log`. Required so the test harness can target a tmpdir without polluting governance state.

## 8. Test coverage (`server/__tests__/` + co-located)

| Suite | Count |
|---|---|
| `utils/totp` | 13 |
| `models/userSession` | 8 |
| `models/userBackupCode` | 5 |
| `models/mfaChallengeNonce` | 8 |
| `utils/middleware/totpRateLimiter` | 6 |
| `utils/middleware/requireTotp` | 9 |
| `utils/middleware/validatedRequest` | 9 |
| `utils/middleware/idleTimeout` | 4 |
| `utils/auth/mfaTokens` | 8 |
| `endpoints/auth/mfa` | 13 |
| `endpoints/loginFlow` | 4 |
| `endpoints/firstRunFlow` | 1 |
| `scripts/disableMfa` | 4 |
| `scripts/revokeUserSessions` | 3 |

All tests run under `--runInBand` (SQLite write contention).

```bash
cd /Vault/anythingllm/src
./node_modules/.bin/jest server/ --runInBand
```
