// vs-fork Plan 4 §C.4c — firm-reference cross-workspace
// retrieval helper.
//
// Plan 4 §C lets a matter workspace opt into pulling chunks
// from the read-only `firm-reference` workspace alongside
// its own retrieval result. This module is a pure addition
// at the time of landing; no callers exist until Task A3
// wires it into apiChatHandler.js + stream.js.
//
// Adaptive cap (per Plan 4 v4 corrected formula at
// docs/plans/2026-05-06-plan-4-brand-prompt-workflows.md:1582):
//
//     fr_cap = matter_hits < 2
//              ? 0
//              : min(floor(K/2), floor(matter_hits/2))
//
// At default K=4 the cap caps at 2; sparse matters
// (matter_hits=0 or 1) get 0 firm-reference chunks so the
// §5.3 "I cannot answer" path is not short-circuited and a
// 1:1 firm-ref-to-matter dilution is forbidden.
//
// MANIFEST.sha256 (`firm_reference_manifest` audit field):
// loaded once per process from the directory pointed to by
// `VS_FIRM_REFERENCE_DIR` (defaults to
// /Vault/runtime/firm-reference). The Plan 4 §C.3 loader
// (Task B2 in the sub-plan) writes the SHA file. If the
// file is absent, the loader returns null and the audit
// row's manifest field is null.
//
// Design: the helper does NOT short-circuit on
// "no MANIFEST.sha256 found" — a missing manifest just
// means firm_reference_manifest stays null in the audit
// row. It DOES short-circuit on:
//   - workspace.cross_workspace_with !== "firm-reference"
//   - fr_cap === 0 (sparse matter)
//   - retrieval returned 0 chunks (e.g. all candidates
//     below similarity threshold; namespace absent on a
//     fresh install) — in this case manifest_sha is null
//     even when the SHA file exists, because no
//     firm-reference chunk contributed to the LLM
//     context.

const fs = require("fs");
const path = require("path");
const { getVectorDbClass } = require("../helpers");

const FIRM_REFERENCE_NAMESPACE = "firm-reference";
const DEFAULT_K = 4;

function firmReferenceDir() {
  return process.env.VS_FIRM_REFERENCE_DIR || "/Vault/runtime/firm-reference";
}

// Sentinel: undefined = not loaded; null = file absent / read error.
let _cachedSha;

/**
 * Read /Vault/runtime/firm-reference/MANIFEST.sha256 (or the
 * VS_FIRM_REFERENCE_DIR override) and cache it for the
 * process lifetime. Returns the trimmed SHA string or null
 * if the file is absent.
 *
 * The cache is invalidatable for tests via the exported
 * `_resetCacheForTests` symbol.
 */
function loadFirmReferenceManifestSha() {
  if (_cachedSha !== undefined) return _cachedSha;
  const target = path.join(firmReferenceDir(), "MANIFEST.sha256");
  try {
    const raw = fs.readFileSync(target, "utf8");
    const trimmed = (raw || "").trim();
    _cachedSha = trimmed.length > 0 ? trimmed : null;
  } catch {
    _cachedSha = null;
  }
  return _cachedSha;
}

function _resetCacheForTests() {
  _cachedSha = undefined;
}

/**
 * Compute the adaptive firm-reference chunk cap. Pure
 * function; exported for test coverage of the cap-table
 * rows.
 *
 * @param {number} matterHits - the number of matter
 *   workspace chunks the caller already retrieved.
 * @param {number} k - top-K from caller; defaults to 4.
 * @returns {number} the firm-reference cap (>= 0).
 */
function adaptiveCap(matterHits, k = DEFAULT_K) {
  const m = Number(matterHits) || 0;
  const K = Number(k) || DEFAULT_K;
  if (m < 2) return 0;
  return Math.min(Math.floor(K / 2), Math.floor(m / 2));
}

/**
 * Fetch firm-reference chunks for a matter workspace's chat
 * turn. Returns merged chunks alongside the audit shape the
 * caller will plumb into `modelMeta`.
 *
 * @param {object} args
 * @param {object} args.workspace - the matter Workspace row.
 *   The helper inspects `workspace.cross_workspace_with`.
 * @param {string} args.input - the query text (post-grepCommand).
 * @param {Array} args.matterChunks - the matter's own
 *   retrieval result (used for matter_hits cap input).
 * @param {number} [args.k] - top-K from caller; default 4.
 * @param {number} [args.similarityThreshold] - matter
 *   workspace's threshold; passed through to the firm-
 *   reference search.
 * @param {object} args.LLMConnector - the live LLMConnector
 *   instance (for embedTextInput).
 * @returns {Promise<{chunks: Array, count: number, manifest_sha: (string|null)}>}
 */
async function fetchFirmReferenceChunks({
  workspace,
  input,
  matterChunks,
  k,
  similarityThreshold,
  LLMConnector,
}) {
  // Guard 1: workspace not opted in.
  if (workspace?.cross_workspace_with !== FIRM_REFERENCE_NAMESPACE) {
    return { chunks: [], count: 0, manifest_sha: null };
  }

  // Guard 2: sparse matter (cap formula returns 0).
  const matterHits = Array.isArray(matterChunks) ? matterChunks.length : 0;
  const fr_cap = adaptiveCap(matterHits, k);
  if (fr_cap === 0) {
    return { chunks: [], count: 0, manifest_sha: null };
  }

  // Guard 3: missing LLMConnector (defensive — in production
  // the caller always passes one, but keep the helper safe
  // for unit tests and for any future caller path).
  if (!LLMConnector) {
    return { chunks: [], count: 0, manifest_sha: null };
  }

  const VectorDb = getVectorDbClass();
  let result;
  try {
    result = await VectorDb.performSimilaritySearch({
      namespace: FIRM_REFERENCE_NAMESPACE,
      input,
      LLMConnector,
      similarityThreshold,
      topN: fr_cap,
    });
  } catch (err) {
    // Defensive: a retrieval failure must not break the
    // chat. Log via console.error (the rest of the chat
    // pipeline uses the same convention) and treat as
    // zero-count.
    // eslint-disable-next-line no-console
    console.error(
      "[firm-reference] retrieval failed; falling back to zero-count",
      { err: err?.message }
    );
    return { chunks: [], count: 0, manifest_sha: null };
  }

  const contextTexts = Array.isArray(result?.contextTexts)
    ? result.contextTexts
    : [];
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  const count = contextTexts.length;

  // Zero-result-after-retrieval (FLAG-2 / FLAG-3 closures
  // from sub-plan v3 + v4): manifest_sha is null whenever
  // count === 0 even if the SHA file exists on disk —
  // firm-reference did not actually contribute to the LLM
  // context, so the audit row should not surface a SHA
  // implying it did.
  if (count === 0) {
    return { chunks: [], count: 0, manifest_sha: null };
  }

  // Merge shape: chunks the caller can splice alongside
  // matterChunks. Each chunk carries both the contextText
  // and the source metadata; the caller decides how to
  // present them in the LLM prompt.
  const merged = contextTexts.map((text, i) => ({
    text,
    source: sources[i] ?? null,
    workspace: FIRM_REFERENCE_NAMESPACE,
  }));

  return {
    chunks: merged,
    count,
    manifest_sha: loadFirmReferenceManifestSha(),
  };
}

module.exports = {
  fetchFirmReferenceChunks,
  loadFirmReferenceManifestSha,
  adaptiveCap,
  firmReferenceDir,
  FIRM_REFERENCE_NAMESPACE,
  DEFAULT_K,
  // Test-only handle to clear the cached SHA between
  // fixture swaps.
  _resetCacheForTests,
};
