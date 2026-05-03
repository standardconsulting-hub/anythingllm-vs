// vs-fork audit middleware. Plan 1 v5 Task 8.
//
// Inline gatekeeper called by every LLM-completion handler:
// AUDIT FIRST, PERSIST SECOND. If audit fails, persistence MUST
// NOT happen. If persistence fails after a successful audit, a
// durable fail-closed flag is written to disk and every
// subsequent call refuses with 503 — process restart cannot
// quietly resume serving (the flag is on disk, not in memory).
//
// Two structural commitments addressing earlier review BLOCKs:
//
//   - **Durable fail-closed flag**: /Vault/audit/_failclose.flag
//     (configurable). Cleared only by scripts/vs-clear-failclose
//     after the COFA reconciles JSONL audit_ids against SQLite
//     turn audit_ids by hand and records the reconciliation in
//     _retention.log.
//
//   - **Durable audit_id**: time-prefixed opaque id generated
//     BEFORE the JSONL write. Same id passed to persistFn so it
//     lands in SQLite. History/export endpoints filter by id
//     presence in the JSONL, not by timestamp matching.
//
// Spec ref: VS Declaration v1.3 §6.1, §7.3.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { makeAuditWriter } = require("./audit-writer");

// Plan 1 v5.1 final-review BLOCK 4: the in-process serialisation
// queue lives on the writer instance. Earlier code created a fresh
// writer on every auditAndPersist call, so concurrent requests
// each had their own chain of length 1 and the JSONL line-integrity
// guarantee was paper-thin. Keep one writer per auditDir for the
// life of the process.
const _writers = new Map();
function getWriter(auditDir) {
  let w = _writers.get(auditDir);
  if (!w) {
    w = makeAuditWriter({ auditDir });
    _writers.set(auditDir, w);
  }
  return w;
}
// Test-only escape hatch so suites that mkdtemp a fresh tmp dir
// per case don't leak chained promises across cases.
function _resetWritersForTests() {
  _writers.clear();
}

class AuditFailure extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AuditFailure";
    this.status = 503;
    this.cause = cause;
  }
}

class PersistFailure extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PersistFailure";
    this.status = 500;
    this.cause = cause;
  }
}

class FailClosedActive extends Error {
  constructor(reason) {
    super(`Audit subsystem in fail-closed state: ${reason}`);
    this.name = "FailClosedActive";
    this.status = 503;
  }
}

function failClosedFlagPath(auditDir) {
  return path.join(auditDir, "_failclose.flag");
}

function checkFailClosed(auditDir) {
  const flagPath = failClosedFlagPath(auditDir);
  try {
    const stat = fs.statSync(flagPath);
    if (stat.isFile()) {
      let contents = "";
      try {
        contents = fs.readFileSync(flagPath, "utf8").trim();
      } catch {
        contents = "(unreadable)";
      }
      throw new FailClosedActive(contents);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return; // healthy
    if (err instanceof FailClosedActive) throw err;
    // Any other stat error (EACCES, etc.) is itself a fail-closed
    // condition — we cannot prove the flag is absent, so we
    // refuse to proceed.
    throw new AuditFailure(
      `Cannot stat fail-closed flag at ${flagPath}: ${err.message}`,
      err
    );
  }
}

async function writeFailClosedFlag(auditDir, reason) {
  const flagPath = failClosedFlagPath(auditDir);
  const contents = JSON.stringify({
    set_at: new Date().toISOString(),
    reason,
    pid: process.pid,
  });
  const fh = await fsp.open(flagPath, "w", 0o600);
  try {
    await fh.write(contents);
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Mirror the Task 7 first-create dirent fsync. Without this,
  // a crash between the file write and the dirent commit on
  // certain filesystems can lose the flag and silently re-open
  // serving on restart.
  const dirFh = await fsp.open(auditDir, "r");
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

// Time-prefixed opaque audit_id. Format: <12-hex ms timestamp>-
// <16-hex random>. NOT UUIDv7 (Node's stdlib has no UUIDv7
// generator); but lex-sortable enough for SQLite ORDER BY and
// JSONL grep, and globally unique within the COFA-only scope.
// Audit log readers should treat the value as opaque.
function newAuditId() {
  const tsHex = Date.now().toString(16).padStart(12, "0");
  const random = crypto.randomBytes(8).toString("hex");
  return `${tsHex}-${random}`;
}

function extractPrompt(request) {
  // The exact prompt-field shape varies per chat surface (see
  // SURVEY.md: streamChatWithWorkspace receives `message`;
  // ApiChatHandler.chatSync receives `message` too). Best-effort
  // capture of the request body until Tasks 9-11 wire each
  // call site explicitly.
  if (!request) return null;
  if (typeof request.body?.message === "string") return request.body.message;
  if (typeof request.body?.prompt === "string") return request.body.prompt;
  return JSON.stringify(request.body ?? null);
}

async function auditAndPersist({
  auditDir = process.env.VS_AUDIT_DIR || "/Vault/audit",
  // vs-fork Plan 2 §E: discriminator. "chat" (default, existing
  // behaviour); "upload_attempt" (Row 1 of doc upload, before
  // collector); "upload_outcome" (Row 2, after collector).
  kind = "chat",
  // For upload_outcome, the caller passes Row 1's audit_id so
  // both rows share an id. For chat + upload_attempt, the
  // middleware mints a fresh id.
  auditId: providedAuditId = null,
  request,
  // chat fields:
  llmResponse,
  retrievedChunks = [],
  modelMeta = {},
  workflow,
  // upload fields:
  upload,           // {filename, sha256, size_bytes, mime, processor}
  uploadOutcome,    // {outcome, duration_ms, collector_message}
  persistFn,
}) {
  // Step 0: durable fail-closed flag wins over everything. If
  // an earlier persistFn failed and an operator hasn't cleared
  // the flag, refuse before doing any work.
  checkFailClosed(auditDir);

  // Step 1: audit_id. Chat + upload_attempt mint fresh; upload_outcome
  // reuses Row 1's id so JOIN works at analysis time.
  const auditId = providedAuditId || newAuditId();

  // Step 2: build the JSONL entry. Shape depends on `kind`.
  let entry;
  if (kind === "chat") {
    entry = {
      audit_id: auditId,
      ts: new Date().toISOString(),
      matter: request?.params?.slug || request?.body?.matter || null,
      workspace_id: request?.params?.slug || null,
      user:
        request?.user?.email ||
        request?.user?.username ||
        request?.locals?.user?.email ||
        request?.locals?.user?.username ||
        "unknown",
      model: modelMeta.model ?? null,
      anythingllm_version: modelMeta.anythingllm_version ?? null,
      system_prompt: modelMeta.system_prompt ?? null,
      firm_reference_manifest: modelMeta.firm_reference_manifest ?? null,
      embedding_model: modelMeta.embedding_model ?? null,
      chunking: modelMeta.chunking ?? null,
      retrieved_chunks: retrievedChunks,
      prompt: extractPrompt(request),
      response: llmResponse,
      tokens_in: modelMeta.tokens_in ?? null,
      tokens_out: modelMeta.tokens_out ?? null,
      latency_ms: modelMeta.latency_ms ?? null,
      cw_pass: false,
      workflow: workflow ?? null,
      citation_check: "not_applicable_v1",
    };
  } else if (kind === "upload_attempt") {
    if (!upload) throw new Error("upload_attempt requires `upload` payload");
    entry = {
      audit_id: auditId,
      ts: new Date().toISOString(),
      kind: "upload_attempt",
      workspace_id: request?.params?.slug || null,
      user:
        request?.user?.email ||
        request?.user?.username ||
        request?.locals?.user?.email ||
        request?.locals?.user?.username ||
        "unknown",
      filename: upload.filename,
      sha256: upload.sha256,
      size_bytes: upload.size_bytes,
      mime: upload.mime,
      processor: upload.processor || "collector",
    };
  } else if (kind === "upload_outcome") {
    if (!providedAuditId)
      throw new Error("upload_outcome requires `auditId` (shared with Row 1)");
    if (!uploadOutcome)
      throw new Error("upload_outcome requires `uploadOutcome` payload");
    entry = {
      audit_id: auditId,
      ts: new Date().toISOString(),
      kind: "upload_outcome",
      outcome: uploadOutcome.outcome,
      duration_ms: uploadOutcome.duration_ms ?? null,
      collector_message: uploadOutcome.collector_message ?? null,
    };
  } else {
    throw new Error(`auditAndPersist: unknown kind '${kind}'`);
  }

  // Step 3: audit write. fsync inside the writer.
  // BLOCK 4 fix: cached singleton writer per auditDir.
  const writer = getWriter(auditDir);
  try {
    await writer.write(entry);
  } catch (err) {
    throw new AuditFailure(
      `Audit subsystem unavailable; query not served (audit_id=${auditId}): ${err.message}`,
      err
    );
  }

  // Step 4: persist. The audit row is already on disk and cannot
  // be un-audited. If persistence fails, we set the durable
  // fail-closed flag so the next call refuses.
  // vs-fork Plan 2 §E: upload kinds are JSONL-only — no SQLite
  // shadow row needed. Silently skip persistFn for upload_*
  // kinds so callers can't accidentally write to a chat table.
  const isUploadKind = kind === "upload_attempt" || kind === "upload_outcome";
  if (persistFn && !isUploadKind) {
    try {
      await persistFn(auditId);
    } catch (err) {
      // BLOCK 5 fix: if we cannot prove the flag was written, we
      // cannot prove subsequent requests will refuse, so the audit
      // subsystem's state is undefined. The only safe response is
      // to crash the process — operator sees the box down, knows
      // to investigate. Logging-and-continuing was the previous
      // behaviour and is what Codex flagged.
      try {
        await writeFailClosedFlag(
          auditDir,
          `Persistence failed for audit_id=${auditId}: ${err.message}`
        );
      } catch (flagErr) {
        // eslint-disable-next-line no-console
        console.error(
          "CRITICAL: audit subsystem cannot write fail-closed flag; aborting process to refuse traffic.",
          { flagErr: flagErr?.message, originalCause: err?.message, auditId }
        );
        // Test-overridable; default behaviour is hard exit.
        (auditAndPersist._onUnflushableFailClose || process.exit)(1);
        // If something replaced process.exit (test mocks), still
        // surface a crash-class error so the caller sees it.
        throw new PersistFailure(
          `CRITICAL: persistence failed and fail-closed flag could not be written (audit_id=${auditId}). ` +
            `flagErr=${flagErr?.message}; originalCause=${err?.message}.`,
          err
        );
      }
      throw new PersistFailure(
        `Persistence failed after audit (audit_id=${auditId}); fail-closed flag written. ` +
          "Reconcile audit JSONL against SQLite by audit_id, then run scripts/vs-clear-failclose.",
        err
      );
    }
  }

  return entry;
}

module.exports = {
  auditAndPersist,
  AuditFailure,
  PersistFailure,
  FailClosedActive,
  checkFailClosed,
  writeFailClosedFlag,
  newAuditId,
  failClosedFlagPath,
  _resetWritersForTests,
};
