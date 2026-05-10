// Tests for convertToChatHistory's Plan 4 §E.2 commit 2
// citation_check propagation contract.
//
// This is the read-side bridge between persisted chat rows and
// the frontend CitationWarning banner (commit 5). A bug here
// would silently break the banner across replays + post-stream
// loads — the §C "dead fields" trap the §E.2 playbook explicitly
// warns about.

const { convertToChatHistory } = require("../responses");

function row(responseBlob, overrides = {}) {
  return {
    id: 1,
    prompt: "what time was the call logged?",
    response: JSON.stringify(responseBlob),
    createdAt: new Date("2026-05-08T10:00:00Z"),
    feedbackScore: null,
    ...overrides,
  };
}

describe("convertToChatHistory — citation_check propagation", () => {
  test("legacy row without citation_check → assistant entry has no citation_check key", () => {
    const out = convertToChatHistory([
      row({ text: "The call was logged at 14:32.", sources: [] }),
    ]);
    const assistant = out[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("The call was logged at 14:32.");
    expect(assistant).not.toHaveProperty("citation_check");
  });

  test("row with citation_check.ok=true → propagated onto assistant entry", () => {
    const out = convertToChatHistory([
      row({
        text: "The call was logged at 14:32 (Bates 005).",
        sources: [],
        citation_check: { ok: true, flagged_sentences: [], reason: null },
      }),
    ]);
    const assistant = out[1];
    expect(assistant.citation_check).toEqual({
      ok: true,
      flagged_sentences: [],
      reason: null,
    });
  });

  test("row with citation_check.ok=false → reason + flagged_sentences propagated", () => {
    const flagged = ["The witness stated the call was logged at 14:32."];
    const out = convertToChatHistory([
      row({
        text: "The witness stated the call was logged at 14:32.",
        sources: [],
        citation_check: {
          ok: false,
          flagged_sentences: flagged,
          reason: "flagged",
        },
      }),
    ]);
    const assistant = out[1];
    expect(assistant.citation_check.ok).toBe(false);
    expect(assistant.citation_check.flagged_sentences).toEqual(flagged);
    expect(assistant.citation_check.reason).toBe("flagged");
  });

  test("legacy row coexisting with citation_check row in same history batch", () => {
    const out = convertToChatHistory([
      row({ text: "Legacy turn.", sources: [] }, { id: 1 }),
      row(
        {
          text: "Newer turn with citation_check.",
          sources: [],
          citation_check: { ok: true, flagged_sentences: [], reason: null },
        },
        { id: 2 }
      ),
    ]);
    expect(out).toHaveLength(4); // 2 user + 2 assistant entries
    expect(out[1]).not.toHaveProperty("citation_check");
    expect(out[3].citation_check.ok).toBe(true);
  });

  test("citation_check explicitly set to null is propagated as null (not stripped)", () => {
    // Future-proofing: an audit middleware that explicitly sets
    // citation_check=null (e.g. for unconditional skip) should not
    // be confused with a legacy row missing the field. The frontend
    // can distinguish "no field" (legacy) from "null" (deliberate).
    const out = convertToChatHistory([
      row({
        text: "Probe response.",
        sources: [],
        citation_check: null,
      }),
    ]);
    const assistant = out[1];
    expect(assistant).toHaveProperty("citation_check");
    expect(assistant.citation_check).toBeNull();
  });
});
