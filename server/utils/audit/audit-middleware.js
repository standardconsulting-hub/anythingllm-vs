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
  request,
  llmResponse,
  retrievedChunks = [],
  modelMeta = {},
  workflow,
  persistFn,
}) {
  // Step 0: durable fail-closed flag wins over everything. If
  // an earlier persistFn failed and an operator hasn't cleared
  // the flag, refuse before doing any work.
  checkFailClosed(auditDir);

  // Step 1: generate the audit_id BEFORE writing the JSONL so
  // the persistFn can store the same value in SQLite. The
  // history/export endpoints filter by audit_id presence, not by
  // timestamp matching.
  const auditId = newAuditId();

  // Step 2: build the JSONL entry.
  const entry = {
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

  // Step 3: audit write. fsync inside the writer.
  const writer = makeAuditWriter({ auditDir });
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
  if (persistFn) {
    try {
      await persistFn(auditId);
    } catch (err) {
      try {
        await writeFailClosedFlag(
          auditDir,
          `Persistence failed for audit_id=${auditId}: ${err.message}`
        );
      } catch (flagErr) {
        // If we cannot even write the flag, the operator must be
        // alerted out of band. Surface the original cause too.
        // eslint-disable-next-line no-console
        console.error(
          "CRITICAL: cannot write fail-closed flag",
          flagErr,
          "original cause:",
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
};
