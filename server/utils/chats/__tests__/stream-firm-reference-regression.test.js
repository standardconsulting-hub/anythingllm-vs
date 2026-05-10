// vs-fork Plan 4 §C — BLOCK-3 regression guard.
//
// Static-analysis regression test for sub-plan v4 line 499:
// `input` to fetchFirmReferenceChunks MUST be the post-
// grepCommand query (`updatedMessage`), not the raw user
// message. The dev-API surface in apiChatHandler.js does
// NOT run grepCommand and therefore correctly passes
// `message` directly. The browser-stream surface in
// stream.js DOES run grepCommand (line 57) and must pass
// the expanded value through to firm-reference retrieval
// to keep its query in lock-step with the matter-side
// vector search (line 262).
//
// This test is deliberately a source-text guard rather than
// a behavioural integration test. The full chat-surface
// integration coverage lives in the BLOCK-1 commit
// (apiChatHandler/stream chat-surface tests). This guard
// fires the moment a future edit re-introduces the original
// bug — before the integration tests would even need to
// run — so it gives early protection at near-zero cost.

const fs = require("fs");
const path = require("path");

const STREAM_PATH = path.resolve(__dirname, "..", "stream.js");
const API_HANDLER_PATH = path.resolve(__dirname, "..", "apiChatHandler.js");

function extractFirmRefCallBodies(source) {
  // Match each `fetchFirmReferenceChunks({ ... })` invocation
  // and return the `{ ... }` body. Lazy on the closing brace
  // so we scope to a single call expression.
  const pattern = /fetchFirmReferenceChunks\(\s*\{([\s\S]*?)\}\s*\)/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

describe("Plan 4 §C BLOCK-3 regression — firm-reference helper input arg", () => {
  test("stream.js passes updatedMessage (post-grepCommand) to fetchFirmReferenceChunks", () => {
    const src = fs.readFileSync(STREAM_PATH, "utf8");
    const bodies = extractFirmRefCallBodies(src);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body).toMatch(/\binput:\s*updatedMessage\b/);
      expect(body).not.toMatch(/\binput:\s*message\b/);
    }
  });

  test("apiChatHandler.js passes message to fetchFirmReferenceChunks (no grepCommand on this surface)", () => {
    const src = fs.readFileSync(API_HANDLER_PATH, "utf8");
    const bodies = extractFirmRefCallBodies(src);
    // Two call sites: chatSync helper (~line 432) and streamChat
    // helper (~line 989). Both must pass `message` directly —
    // this surface does NOT run grepCommand. If someone later
    // adds grepCommand support to the dev-API surface, this
    // guard's grepCommand-import assertion below will trip and
    // force the same updatedMessage treatment as stream.js.
    expect(bodies.length).toBe(2);
    for (const body of bodies) {
      expect(body).toMatch(/\binput:\s*message\b/);
    }
    expect(src).not.toMatch(/\bgrepCommand\b/);
  });
});
