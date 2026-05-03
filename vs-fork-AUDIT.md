# vs-fork: audit pipeline (Plan 1 Tasks 7–11, v5.1)

This document is the operator-facing reference for the
audit chain shipped by Plan 1 Tasks 7–11. It complements
`vs-fork-MFA.md` (Plan 1.5) at the fork root.

> Plan ref: `docs/plans/2026-04-30-plan-1-foundation-and-audit.md`
> §Tasks 7–11. Spec ref: VS Declaration v1.3 §6.1, §7.3.
> v5.1 patch resolves five BLOCKs from the final-Codex review;
> see §7 below.

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
- **Abort propagation in `BufferingResponse`** is intentionally
  a no-op. Upstream provider code attaches a listener via
  `response.on("close", handleAbort)` to short-circuit the LLM
  if the user disconnects mid-stream. Under the audit-pause
  pattern the user has no live connection to disconnect from
  (chunks are buffered) until after audit fsync, so honouring
  abort would either (a) deliver a partial answer with no
  audit row, violating the AUDIT-FIRST guarantee, or
  (b) cancel the audit row mid-flight, leaving an undefined
  state. Both worse than letting the LLM finish into the
  buffer. Documented here so a future reader doesn't "fix" the
  shim.

## 6. Test coverage

Audit tests in `server/utils/audit/__tests__/`:

| Suite | Count | What it covers |
|---|---|---|
| `audit-writer.test.js` | 8 | line-shape + UTC day-stamp + 0600 perms + appends + date-boundary roll + UTC-not-local + fresh-fd fsync proof + concurrent serialisation |
| `audit-middleware.test.js` | 8 | happy-path round-trip + audit failure no-persist + persist failure writes flag + pre-existing flag refuses + audit_id ms-prefix monotonicity + **v5.1 BLOCK 1: persistFn-throw drives flag write** + **v5.1 BLOCK 4: concurrent calls share one queue per auditDir** + **v5.1 BLOCK 5: hard-exit when flag write itself fails** |
| `bufferingResponse.test.js` | 8 | chunk capture + ordered replay + headers replay + status replay + `.json` + write-after-end no-op + EventEmitter shape + skip-headers-on-committed-real |

Runs with the rest of the server suite under `--runInBand`:

```bash
cd /Vault/anythingllm/src
./node_modules/.bin/jest server/ --runInBand
```

Total at the time of this commit: 225 passed across 32 suites
(plus one pre-existing cross-endpoint replay flake from Plan 1.5
that surfaces under heavy parallelism — same as the prior commit).

## 7. v5.1 patch — final-Codex BLOCK fixes

The first end-to-end smoke proved the audit pipeline live, then
Codex (gpt-5.5, high reasoning, read-only sandbox) reviewed the
five-commit diff and surfaced five BLOCK-class issues. All five
are now fixed; the FLAGs in §5 stand as documented deviations.

| BLOCK | What broke the guarantee | Fix |
|---|---|---|
| 1 | `WorkspaceChats.new` swallows prisma errors and returns `{chat: null, message}`. The original `persistFn` ignored that shape, so `auditAndPersist` thought persistence succeeded and skipped writing the fail-closed flag — defeating the whole mechanism for the SQLite failure modes the plan promises to catch. | Each `persistFn` now `throw`s on `!result.chat \|\| result.message`. `auditAndPersist`'s catch then writes the flag and throws `PersistFailure`. |
| 2 | Non-streaming `chatSync` converted `AuditFailure` / `PersistFailure` / `FailClosedActive` into a normal `{type: "abort"}` payload, and the route handlers in `api/workspace/index.js` and `api/workspaceThread/index.js` returned HTTP **200**. Spec §6.1 says "every subsequent chat returns 503 until recovery" — that was violated for the dev-API non-streaming surface. | `chatSync` re-throws audit errors. The two route handlers gain the same `if (e instanceof FailClosedActive\|AuditFailure\|PersistFailure)` shape used in the streaming routes — 503 with `audit_state` field. |
| 3 | `audit_id` was a two-step `WorkspaceChats.new` then `prisma.workspace_chats.update`. A crash between the two left a row with `audit_id NULL` and **no fail-close flag** — breaking the round-trip guarantee under crash. | `WorkspaceChats.new` now accepts an optional `auditId` and bakes it into the single `create`. The post-create `update` call is removed at all three hook sites. |
| 4 | `audit-writer`'s in-process serialisation queue lives on the writer instance, but `auditAndPersist` was creating a fresh writer on every request. Each concurrent request had its own chain of length 1, so the JSONL line-integrity guarantee was paper-thin. | Module-scoped writer cache in `audit-middleware.js` keyed on `auditDir`. New test (`BLOCK 4`) drives 12 parallel `auditAndPersist` calls and asserts 12 well-formed JSONL lines + 12 unique `audit_id`s. |
| 5 | If `writeFailClosedFlag` itself failed (disk full, perms), the code logged and continued to throw a `PersistFailure` whose message claimed the flag had been written. Subsequent requests would not fail closed — silent regression of the most important guarantee. | If the flag write throws, the audit subsystem's state is undefined; the only safe response is to refuse all traffic. The middleware now logs the original cause + flag-write failure and calls `process.exit(1)`. Test mocks the exit hook via `auditAndPersist._onUnflushableFailClose`. |

While auditing the diff for BLOCK 2, one additional gap surfaced
that Codex did not explicitly call out: the dev-API thread
streaming endpoint `/v1/workspace/:slug/thread/:threadSlug/stream-chat`
in `endpoints/api/workspaceThread/index.js` was missed in the
original Task 10 refactor — it wrote SSE chunks straight to the
real Express response. Tokens reached the user before audit
fsync. v5.1 refactors it to the same `BufferingResponse` pattern
as the other three streaming surfaces.

`@@index([audit_id])` was redundant with `@unique` (FLAG 9) and
has been dropped from the schema. A follow-up migration
`20260503120000_vs_audit_id_idx_dedupe` removes the dead index
from existing databases. The unique index is the only one needed
for `WHERE audit_id = ?` lookups.
