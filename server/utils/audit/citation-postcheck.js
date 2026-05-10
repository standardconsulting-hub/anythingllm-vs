// vs-fork citation post-check helper — Plan 4 §E.2 Commit 1.
//
// Wraps `scripts/vs-citation-postcheck` (a zsh+python3 helper
// shipped on the plan-1-foundation repo at commit 96b771f) so
// that audit middleware code can call it from JS as
// `await runCitationPostcheck(responseText)`.
//
// Spec ref: §5.4 — the post-check is shape-only (does the
// assistant's output cite its sources?); substantive
// verification is the fee-earner's responsibility.
//
// This module is intentionally a DEAD MODULE in Commit 1: it
// has no callers in the fork yet. Commit 3 (apiChatHandler)
// and Commit 4 (stream.js + audit-middleware schema bump)
// wire it in at every WorkspaceChats.new site.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_TIMEOUT_MS = 5000;

// Result shapes returned to callers:
//   { ok: true,  flagged_sentences: [] }
//   { ok: false, flagged_sentences: ["..."], reason: "flagged" }
//   { ok: false, flagged_sentences: [],     reason: "timeout",         error: "..." }
//   { ok: false, flagged_sentences: [],     reason: "script_error",    error: "..." }
//   { ok: false, flagged_sentences: [],     reason: "invalid_output",  error: "..." }
//   { ok: false, flagged_sentences: [],     reason: "spawn_error",     error: "..." }
//   { ok: false, flagged_sentences: [],     reason: "no_script",       error: "..." }
//
// Commit 4 will record `ok` (boolean) on the audit row's
// citation_check field; flagged_sentences + reason feed the
// UI banner (Commit 5).
async function runCitationPostcheck(responseText, options = {}) {
  const scriptPath =
    options.scriptPath || process.env.VS_CITATION_POSTCHECK_SCRIPT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!scriptPath) {
    return {
      ok: false,
      flagged_sentences: [],
      reason: "no_script",
      error:
        "VS_CITATION_POSTCHECK_SCRIPT not set and no scriptPath option provided",
    };
  }

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-citation-"));
  } catch (err) {
    return {
      ok: false,
      flagged_sentences: [],
      reason: "spawn_error",
      error: `tmpdir failed: ${err?.message ?? String(err)}`,
    };
  }

  const inputPath = path.join(tmpDir, "response.txt");
  try {
    fs.writeFileSync(inputPath, responseText ?? "", "utf8");
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      ok: false,
      flagged_sentences: [],
      reason: "spawn_error",
      error: `tmpfile failed: ${err?.message ?? String(err)}`,
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timer;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; do not let cleanup errors mask the result.
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(scriptPath, [inputPath], { env: process.env });
    } catch (err) {
      finish({
        ok: false,
        flagged_sentences: [],
        reason: "spawn_error",
        error: err?.message ?? String(err),
      });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process may already be gone.
      }
      finish({
        ok: false,
        flagged_sentences: [],
        reason: "timeout",
        error: `Citation post-check exceeded ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        flagged_sentences: [],
        reason: "spawn_error",
        error: err?.message ?? String(err),
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          flagged_sentences: [],
          reason: "script_error",
          error: stderr.trim() || `script exited with code ${code}`,
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        finish({
          ok: false,
          flagged_sentences: [],
          reason: "invalid_output",
          error: `JSON parse failed: ${err?.message ?? String(err)}`,
        });
        return;
      }
      const ok = parsed && parsed.ok === true;
      const flagged = Array.isArray(parsed?.flagged_sentences)
        ? parsed.flagged_sentences
        : [];
      finish({
        ok,
        flagged_sentences: flagged,
        reason: ok ? null : "flagged",
      });
    });
  });
}

module.exports = { runCitationPostcheck };
