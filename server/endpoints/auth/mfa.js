// vs-fork MFA endpoints. Plan 1.5 v1.2.1 Task 3.
//
// Mounted by server/index.js under /api/auth/mfa/. Every TOTP-
// validating endpoint runs through totpRateLimiter first (lockout
// gate), then totp.verify(...), then totp.consumeTotpCounter(...)
// (cross-endpoint replay defence), then logAttempt(outcome).

const prisma = require("../../utils/prisma");
const totp = require("../../utils/totp");
const {
  totpRateLimiter,
  logAttempt,
} = require("../../utils/middleware/totpRateLimiter");
const {
  requireFullAuth,
  requireFreshStepUp,
} = require("../../utils/middleware/requireTotp");
const {
  issueChallengeToken,
  consumeChallengeToken,
  issueSessionToken,
  CHALLENGE_AUD,
  ENROLMENT_AUD,
  CHALLENGE_TTL_SECONDS,
} = require("../../utils/auth/mfaTokens");
const { UserSession } = require("../../models/userSession");
const { UserBackupCode } = require("../../models/userBackupCode");
const { reqBody } = require("../../utils/http");

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

/**
 * Decode + atomically consume a challenge JWT from the body
 * (`challenge_token`). On failure returns null AND writes the
 * 401 response. On success returns { user_id }.
 */
async function consumeChallengeOrReject(req, res, expectedAud) {
  const body = reqBody(req) || {};
  const result = await consumeChallengeToken(body.challenge_token, expectedAud);
  if (!result.ok) {
    res.status(401).json({
      error: "challenge_token_invalid",
      reason: result.reason,
    });
    return null;
  }
  return { user_id: result.user_id };
}

/**
 * Sets res.locals.mfaUserId before the rate limiter runs so it can
 * scope the lockout per-user.
 */
function bindMfaUserFromBody(req, res, next) {
  const body = reqBody(req) || {};
  // The body's challenge_token is signed; we still don't fully
  // trust it before consume(), but we DO trust the JWT signature
  // for purposes of scoping the rate limiter (the wrong user's
  // lockout is still preferable to no lockout at all).
  if (body.challenge_token) {
    try {
      const JWT = require("jsonwebtoken");
      const decoded = JWT.verify(
        body.challenge_token,
        process.env.JWT_SECRET,
        { algorithms: ["HS256"] }
      );
      const sub = parseInt(decoded.sub, 10);
      if (Number.isFinite(sub)) res.locals.mfaUserId = sub;
    } catch {
      /* fall through with no mfaUserId */
    }
  }
  next();
}

function bindMfaUserFromSession(req, res, next) {
  res.locals.mfaUserId = res.locals?.user?.id ?? null;
  next();
}

function mfaEndpoints(app) {
  if (!app) return;

  // ----- POST /api/auth/mfa/enrol -----
  // Bootstrap the secret. Caller already holds an enrolment
  // challenge token (issued by the password-login endpoint when
  // the user has no totp_verified_at yet — implemented in Task 4).
  // Returns { otpauth_url, qr_data_url, challenge_token } where
  // challenge_token is a fresh enrolment token for /enrol/confirm.
  app.post(
    "/auth/mfa/enrol",
    [bindMfaUserFromBody, totpRateLimiter],
    async (req, res) => {
      try {
        const c = await consumeChallengeOrReject(req, res, ENROLMENT_AUD);
        if (!c) return;

        const secret = totp.generateSecret();
        const ciphertext = totp.encryptSecret(secret);
        if (!ciphertext) {
          return res
            .status(500)
            .json({ error: "encryption_manager_unavailable" });
        }
        await prisma.users.update({
          where: { id: c.user_id },
          data: {
            totp_secret_ciphertext: ciphertext,
            // Resetting verified_at here too so an in-progress
            // re-enrol can't smuggle a half-finished state through.
            totp_verified_at: null,
            totp_last_used_counter: null,
          },
        });

        const user = await prisma.users.findUnique({
          where: { id: c.user_id },
        });
        const otpauth_url = totp.generateOtpauthUrl(
          secret,
          user.username || `user-${user.id}`
        );
        const qr_data_url = await totp.qrCodeDataUrl(otpauth_url);

        // Mint the next-leg challenge token so /enrol/confirm has
        // a fresh, signed handshake.
        const next = await issueChallengeToken({
          userId: c.user_id,
          aud: ENROLMENT_AUD,
          remoteIp: req.ip,
          userAgent: req.headers?.["user-agent"] || null,
        });
        res.set(NO_STORE);
        return res.status(200).json({
          otpauth_url,
          qr_data_url,
          challenge_token: next.token,
          challenge_expires_at: next.expires_at.toISOString(),
        });
      } catch (e) {
        console.error("[mfa/enrol]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );

  // ----- POST /api/auth/mfa/enrol/confirm -----
  // Caller types the first 6-digit code AND sends the fresh
  // enrolment challenge_token from /enrol's response. On success:
  // mark totp_verified_at, seed user_backup_codes, return the
  // plaintext codes exactly once.
  app.post(
    "/auth/mfa/enrol/confirm",
    [bindMfaUserFromBody, totpRateLimiter],
    async (req, res) => {
      try {
        const c = await consumeChallengeOrReject(req, res, ENROLMENT_AUD);
        if (!c) return;

        const body = reqBody(req) || {};
        const code = String(body.code || "");
        const user = await prisma.users.findUnique({
          where: { id: c.user_id },
        });
        if (!user || !user.totp_secret_ciphertext) {
          await logAttempt({
            userId: c.user_id,
            remoteIp: req.ip,
            outcome: "fail_invalid",
          });
          return res.status(400).json({ error: "no_pending_enrolment" });
        }
        const secret = totp.decryptSecret(user.totp_secret_ciphertext);
        const verifyResult = totp.verify(secret, code, {
          lastUsedCounter: user.totp_last_used_counter,
        });
        if (!verifyResult.valid) {
          await logAttempt({
            userId: c.user_id,
            remoteIp: req.ip,
            outcome:
              verifyResult.reason === "replay" ? "fail_replay" : "fail_invalid",
          });
          return res.status(400).json({
            error: "invalid_code",
            reason: verifyResult.reason,
          });
        }

        const won = await totp.consumeTotpCounter(
          prisma,
          c.user_id,
          verifyResult.counter
        );
        if (!won) {
          await logAttempt({
            userId: c.user_id,
            remoteIp: req.ip,
            outcome: "fail_replay",
          });
          return res
            .status(400)
            .json({ error: "invalid_code", reason: "replay" });
        }

        // Seed backup codes.
        const codes = totp.generateBackupCodes();
        const hashes = await totp.hashBackupCodes(codes);
        await UserBackupCode.wipe(c.user_id);
        await UserBackupCode.seed(c.user_id, hashes);

        await prisma.users.update({
          where: { id: c.user_id },
          data: { totp_verified_at: new Date() },
        });

        await logAttempt({
          userId: c.user_id,
          remoteIp: req.ip,
          outcome: "ok",
        });

        res.set(NO_STORE);
        return res.status(200).json({
          enrolled: true,
          backup_codes: codes,
          backup_codes_count: codes.length,
        });
      } catch (e) {
        console.error("[mfa/enrol/confirm]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );

  // ----- POST /api/auth/mfa/challenge -----
  // Caller has just authenticated with password and holds an
  // mfa-challenge token. They type a 6-digit code OR a backup
  // code. On success: mint the full session JWT and create the
  // user_sessions row.
  app.post(
    "/auth/mfa/challenge",
    [bindMfaUserFromBody, totpRateLimiter],
    async (req, res) => {
      try {
        const c = await consumeChallengeOrReject(req, res, CHALLENGE_AUD);
        if (!c) return;

        const body = reqBody(req) || {};
        const code = String(body.code || "");
        const isBackup = body.use_backup_code === true;

        const user = await prisma.users.findUnique({
          where: { id: c.user_id },
        });
        if (!user || !user.totp_verified_at) {
          await logAttempt({
            userId: c.user_id,
            remoteIp: req.ip,
            outcome: "fail_invalid",
          });
          return res.status(400).json({ error: "not_enrolled" });
        }

        let success = false;
        if (isBackup) {
          const r = await UserBackupCode.consumeIfValid(c.user_id, code);
          if (!r.ok) {
            await logAttempt({
              userId: c.user_id,
              remoteIp: req.ip,
              outcome: "fail_invalid",
            });
            return res.status(400).json({ error: "invalid_code" });
          }
          success = true;
        } else {
          const secret = totp.decryptSecret(user.totp_secret_ciphertext);
          const verifyResult = totp.verify(secret, code, {
            lastUsedCounter: user.totp_last_used_counter,
          });
          if (!verifyResult.valid) {
            await logAttempt({
              userId: c.user_id,
              remoteIp: req.ip,
              outcome:
                verifyResult.reason === "replay"
                  ? "fail_replay"
                  : "fail_invalid",
            });
            return res.status(400).json({
              error: "invalid_code",
              reason: verifyResult.reason,
            });
          }
          const won = await totp.consumeTotpCounter(
            prisma,
            c.user_id,
            verifyResult.counter
          );
          if (!won) {
            await logAttempt({
              userId: c.user_id,
              remoteIp: req.ip,
              outcome: "fail_replay",
            });
            return res
              .status(400)
              .json({ error: "invalid_code", reason: "replay" });
          }
          success = true;
        }

        if (!success) {
          // Should be unreachable, but defensive.
          return res.status(400).json({ error: "invalid_code" });
        }

        // Mint a full session.
        const session = await UserSession.create({
          userId: c.user_id,
          remoteIp: req.ip,
          userAgent: req.headers?.["user-agent"] || null,
        });
        // First step-up is implicit in passing the challenge.
        await UserSession.markStepUp(session.id);

        const token = issueSessionToken({
          userId: c.user_id,
          sessionId: session.id,
          expiresAt: session.expires_at,
        });

        await logAttempt({
          userId: c.user_id,
          remoteIp: req.ip,
          outcome: "ok",
        });

        res.set(NO_STORE);
        return res.status(200).json({
          session_token: token,
          session_id: session.id,
          expires_at: session.expires_at.toISOString(),
        });
      } catch (e) {
        console.error("[mfa/challenge]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );

  // ----- POST /api/auth/mfa/step-up -----
  // Caller is fully authed and wants to refresh last_step_up_at
  // on the calling session ONLY (not all the user's sessions).
  app.post(
    "/auth/mfa/step-up",
    [requireFullAuth, bindMfaUserFromSession, totpRateLimiter],
    async (req, res) => {
      try {
        const body = reqBody(req) || {};
        const code = String(body.code || "");
        const user = res.locals.user;
        const session = res.locals.session;
        const secret = totp.decryptSecret(user.totp_secret_ciphertext);
        const verifyResult = totp.verify(secret, code, {
          lastUsedCounter: user.totp_last_used_counter,
        });
        if (!verifyResult.valid) {
          await logAttempt({
            userId: user.id,
            remoteIp: req.ip,
            outcome:
              verifyResult.reason === "replay" ? "fail_replay" : "fail_invalid",
          });
          return res.status(400).json({
            error: "invalid_code",
            reason: verifyResult.reason,
          });
        }
        const won = await totp.consumeTotpCounter(
          prisma,
          user.id,
          verifyResult.counter
        );
        if (!won) {
          await logAttempt({
            userId: user.id,
            remoteIp: req.ip,
            outcome: "fail_replay",
          });
          return res
            .status(400)
            .json({ error: "invalid_code", reason: "replay" });
        }
        await UserSession.markStepUp(session.id);
        await logAttempt({
          userId: user.id,
          remoteIp: req.ip,
          outcome: "ok",
        });
        res.set(NO_STORE);
        return res.status(200).json({ stepped_up: true });
      } catch (e) {
        console.error("[mfa/step-up]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );

  // ----- POST /api/auth/mfa/disable -----
  app.post(
    "/auth/mfa/disable",
    [requireFullAuth, requireFreshStepUp(5)],
    async (req, res) => {
      try {
        const userId = res.locals.user.id;
        await prisma.users.update({
          where: { id: userId },
          data: {
            totp_secret_ciphertext: null,
            totp_verified_at: null,
            totp_last_used_counter: null,
            must_rotate_password: true,
          },
        });
        await UserBackupCode.wipe(userId);
        const revoked = await UserSession.revokeAllForUser(
          userId,
          "disable_mfa"
        );
        // Also wipe any pending challenge nonces for this user so
        // they cannot complete an in-flight enrolment with the old
        // secret.
        await prisma.mfa_challenge_nonces.deleteMany({
          where: { user_id: userId },
        });
        res.set(NO_STORE);
        return res
          .status(200)
          .json({ disabled: true, revoked_sessions: revoked });
      } catch (e) {
        console.error("[mfa/disable]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );

  // ----- POST /api/auth/mfa/backup-codes/regenerate -----
  app.post(
    "/auth/mfa/backup-codes/regenerate",
    [requireFullAuth, requireFreshStepUp(5)],
    async (req, res) => {
      try {
        const userId = res.locals.user.id;
        const codes = totp.generateBackupCodes();
        const hashes = await totp.hashBackupCodes(codes);
        await UserBackupCode.wipe(userId);
        await UserBackupCode.seed(userId, hashes);
        res.set(NO_STORE);
        return res
          .status(200)
          .json({ backup_codes: codes, backup_codes_count: codes.length });
      } catch (e) {
        console.error("[mfa/backup-codes/regenerate]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );

  // ----- POST /api/auth/mfa/sessions/revoke-all -----
  // Operator-driven lost-device action. Mirrors disable-mfa
  // semantics on must_rotate_password but keeps the MFA secret +
  // backup codes intact.
  app.post(
    "/auth/mfa/sessions/revoke-all",
    [requireFullAuth, requireFreshStepUp(5)],
    async (req, res) => {
      try {
        const userId = res.locals.user.id;
        const revoked = await UserSession.revokeAllForUser(
          userId,
          "lost_device"
        );
        await prisma.users.update({
          where: { id: userId },
          data: { must_rotate_password: true },
        });
        res.set(NO_STORE);
        return res.status(200).json({
          revoked_sessions: revoked,
          must_rotate_password: true,
        });
      } catch (e) {
        console.error("[mfa/sessions/revoke-all]", e);
        return res.status(500).json({ error: "internal_error" });
      }
    }
  );
}

module.exports = {
  mfaEndpoints,
  // Exported for endpoint tests that need to stub out internals
  // without spinning up the full express app.
  CHALLENGE_TTL_SECONDS,
};
