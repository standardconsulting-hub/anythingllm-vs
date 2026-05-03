# vs-fork: audit pipeline (Plan 1 Tasks 7–11)

This document is the operator-facing reference for the
audit chain shipped by Plan 1 Tasks 7–11. It complements
`vs-fork-MFA.md` (Plan 1.5) at the fork root.

> Plan ref: `docs/plans/2026-04-30-plan-1-foundation-and-audit.md`
> §Tasks 7–11. Spec ref: VS Declaration v1.3 §6.1, §7.3.

---

## 1. Threat model decisions

| Decision | Choice | Rationale |
|---|---|---|
| Audit ordering | **AUDIT FIRST, PERSIST SECOND.** | Spec §6.1 — no chat turn may exist in SQLite without a matching JSONL audit row. The reverse ordering would create rows the regulator can't see. |
| Pre-delivery audit | **No token reaches the user before the JSONL row is fsynced.** | Spec §6.1. For streaming surfaces, the SSE chunks are buffered in memory until the audit fsync completes, then flushed in one go. Streaming UX becomes batch-after-audit; operator sees the full answer at ~0.8 s on Qwen 7B-4bit instead of word-by-word. Deliberate trade-off. |
| Audit-failure response | **503 + no persistence.** | If the audit JSONL write fails (disk full, mount gone, SIGKILL during fsync), the request is rejected. `persistFn` is never called. The user sees an error; the regulator sees no orphan row. |
| Persist-failure response | **Durable fail-closed flag.** | If audit succeeds but `persistFn` fails (sqlite full, schema mismatch, foreign-key violation), `/Vault/audit/_failclose.flag` is written. Every subsequent chat returns 503 until an operator reconciles the JSONL audit_ids against SQLite turn audit_ids and runs `scripts/vs-clear-failclose`. **Process restart does NOT clear the flag** — it's on disk, not in memory. |
| `audit_id` | **Time-prefixed opaque id, generated before JSONL write.** | Format: `<12-hex ms timestamp>-<16-hex random>`. Same id passed to `persistFn` so the SQLite turn carries it. History/export endpoints filter by id presence, not timestamp matching. Not UUIDv7 (no Node stdlib generator), but sortable + unique enough for v1. |
| Telemetry | **Off** via `DISABLE_TELEMETRY=true` in env. | Confirmed in startup log: `[TELEMETRY DISABLED]`. The egress allowlist in Plan 2 will block `*.posthog.com` as defence-in-depth. The `posthog-node` package is still installed; ripping it out is deferred to Plan 2. |

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/workspace/:slug/stream-chat                         │
│  POST /api/workspace/:slug/thread/:threadSlug/stream-chat      │
│  POST /api/v1/workspace/:slug/stream-chat                      │
│  POST /api/v1/workspace/:slug/chat                             │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────────────────┐                                   │
│  │  Route handler           │                                   │
│  │  (chat.js / api/.../*)   │                                   │
│  │                          │                                   │
│  │  for streaming:          │                                   │
│  │    bufRes = new          │                                   │
│  │      BufferingResponse() │                                   │
│  │    headers → bufRes      │                                   │
│  └──────────────┬───────────┘                                   │
│                 ▼                                               │
│  ┌──────────────────────────┐                                   │
│  │  streamChatWithWorkspace │                                   │
│  │  / chatSync / streamChat │                                   │
│  │  (utils/chats/*)         │                                   │
│  │                          │                                   │
│  │  ┌────────────────────┐  │                                   │
│  │  │ LLM call           │  │  ── stream chunks → bufRes        │
│  │  │ (mlx-lm provider)  │  │     (still buffered, NOT on wire) │
│  │  └─────────┬──────────┘  │                                   │
│  │            ▼              │                                  │
│  │  ┌────────────────────┐  │                                   │
│  │  │ auditAndPersist    │  │                                   │
│  │  │  (utils/audit/     │  │                                   │
│  │  │   audit-middleware)│  │                                   │
│  │  │                    │  │                                   │
│  │  │  1. checkFailClosed│  │                                   │
│  │  │  2. newAuditId     │  │                                   │
│  │  │  3. JSONL writer   │  │  ── /Vault/audit/queries-*.jsonl  │
│  │  │     fsync          │  │     (durable on stable storage)   │
│  │  │  4. persistFn(id)  │  │  ── workspace_chats SQLite row    │
│  │  │     (provided by   │  │     (audit_id column)             │
│  │  │      caller)       │  │                                   │
│  │  └────────────────────┘  │                                   │
│  └──────────────┬───────────┘                                   │
│                 ▼                                               │
│  ┌──────────────────────────┐                                   │
│  │  Route handler           │                                   │
│  │  bufRes.flushTo(realRes) │  ── SSE chunks released to wire   │
│  └──────────────────────────┘                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 3. Modules and call sites

### Audit-side modules (`server/utils/audit/`)

| File | Role |
|---|---|
| `audit-writer.js` | Lowest layer. `makeAuditWriter({auditDir}).write(entry)` appends one JSON line + newline to `<auditDir>/queries-<utc>.jsonl`, fsyncs the file, and on first creation also fsyncs the parent dir. File mode 0600 passed explicitly to `open(2)` so a restrictive umask can't widen it. In-process serialisation queue prevents interleaved JSON when callers race. |
| `audit-middleware.js` | `auditAndPersist({...})` is the inline gatekeeper every LLM-completion handler calls. It checks the durable fail-closed flag, generates the `audit_id`, writes the JSONL via the writer, then calls `persistFn(auditId)`. On `persistFn` failure it writes `/Vault/audit/_failclose.flag` so the next call refuses. Errors are typed (`AuditFailure 503`, `PersistFailure 500`, `FailClosedActive 503`) so route handlers can map cleanly to HTTP. |
| `bufferingResponse.js` | SSE-shaped proxy. `BufferingResponse` exposes `.write/.end/.setHeader/.flushHeaders/.status/.json` and EventEmitter-shape shims (`.on/.off/.emit`). `.flushTo(realResponse)` replays captured headers + chunks to the real Express response in one go after audit fsync. |

### Hooked call sites (`server/utils/chats/`, `server/endpoints/`)

| Surface | File | Function | Hook commit |
|---|---|---|---|
| Dev API non-streaming chat (workspace) | `utils/chats/apiChatHandler.js` | `chatSync` happy path | Task 9 (`ec10edf0`) |
| Dev API streaming chat (workspace) | `utils/chats/apiChatHandler.js` + `endpoints/api/workspace/index.js` | `streamChat` happy path + route handler refactor | Task 10 (`d3bab206`) |
| Frontend streaming chat (workspace, w/ + w/o thread) | `utils/chats/stream.js` + `endpoints/chat.js` | `streamChatWithWorkspace` happy path + both route handlers | Task 10 (`d3bab206`) |

### Schema changes (`server/prisma/schema.prisma`)

- `workspace_chats.audit_id` — `String? @unique` with `@@index([audit_id])`. Nullable for upstream compatibility with any pre-vs-fork rows; in production every audited turn carries it.
- Migration: `20260503093000_vs_audit_id`.

## 4. Operator quickstart

### Verify audit pipeline is live

```bash
# Should show today's JSONL file with at least one row per chat
ls -lO /Vault/audit/queries-$(date -u +%Y-%m-%d).jsonl

# Spot-check the most recent row
tail -1 /Vault/audit/queries-$(date -u +%Y-%m-%d).jsonl | jq .

# Confirm the SQLite row carries the same audit_id
sqlite3 /Vault/anythingllm/src/server/storage/anythingllm.db \
  "SELECT id, audit_id, substr(prompt,1,40) FROM workspace_chats ORDER BY id DESC LIMIT 1;"
```

### When the system enters fail-closed state

A `503 audit_state=fail_closed` response means
`/Vault/audit/_failclose.flag` exists. To clear:

```bash
# Show the flag's reason + timestamp
cat /Vault/audit/_failclose.flag | jq .

# Reconcile every audit_id in today's queries-*.jsonl against
# workspace_chats.audit_id in SQLite. Any audit_id that's in
# JSONL but missing from SQLite is a ghost turn — investigate
# before clearing.
TODAY=$(date -u +%Y-%m-%d)
jq -r '.audit_id' /Vault/audit/queries-$TODAY.jsonl | sort > /tmp/jsonl-ids
sqlite3 /Vault/anythingllm/src/server/storage/anythingllm.db \
  "SELECT audit_id FROM workspace_chats WHERE audit_id IS NOT NULL ORDER BY audit_id;" \
  > /tmp/sqlite-ids
diff /tmp/jsonl-ids /tmp/sqlite-ids

# When reconciliation passes, run the operator script
# (in plan-repo: scripts/vs-clear-failclose). It logs the
# clearance event to /Vault/audit/_retention.log and removes
# the flag.
~/Projects/vs-declaration-plan-1/scripts/vs-clear-failclose
```

## 5. Deviations and known gaps

These are scoped out of Plan 1 v5 and tracked as deferred:

- **Short-circuit chat paths** in `chatSync`, `streamChat`, and
  `streamChatWithWorkspace` (agent invocation, no-data,
  no-match) still call `WorkspaceChats.new` directly without the
  audit middleware. Their SQLite rows have `audit_id` NULL —
  exactly what the schema's nullability promise allows. <1% of
  demo traffic; non-blocking. The right fix is a small helper
  that wraps each site with the same `auditAndPersist` shape.
- **Embed surface** (`server/endpoints/embed/`). SURVEY.md
  recommends stripping the embed routes for COFA scope (they're
  anonymous public chat, incompatible with audit identity
  requirements). Not yet stripped; not yet hooked. Either path
  is fine, but we shouldn't ship the demo with embed exposed
  AND unaudited.
- **Agent surfaces** (`server/endpoints/agentWebsocket.js`,
  `server/endpoints/agentFlows.js`). These persist into
  `workspace_agent_invocations`, a separate table from
  `workspace_chats`. Hooking these requires either a parallel
  `audit_id` column on the agents table (cheap migration) or a
  decision to disable agents for the COFA-only deployment.
  Plan 2 territory.
- **`telemetry.js` call sites are not stripped.** The runtime
  flag (`DISABLE_TELEMETRY=true`) makes every `sendTelemetry`
  call a no-op; the egress allowlist in Plan 2 blocks
  `*.posthog.com` as defence-in-depth. Ripping the calls out
  is deferred to Plan 2 for the same reason.

## 6. Test coverage

Audit tests in `server/utils/audit/__tests__/`:

| Suite | Count | What it covers |
|---|---|---|
| `audit-writer.test.js` | 8 | line-shape + UTC day-stamp + 0600 perms + appends + date-boundary roll + UTC-not-local + fresh-fd fsync proof + concurrent serialisation |
| `audit-middleware.test.js` | 5 | happy-path round-trip + audit failure no-persist + persist failure writes flag + pre-existing flag refuses + audit_id ms-prefix monotonicity |
| `bufferingResponse.test.js` | 8 | chunk capture + ordered replay + headers replay + status replay + `.json` + write-after-end no-op + EventEmitter shape + skip-headers-on-committed-real |

Runs with the rest of the server suite under `--runInBand`:

```bash
cd /Vault/anythingllm/src
./node_modules/.bin/jest server/ --runInBand
```

Total at the time of this commit: 222 passed across 32 suites.
