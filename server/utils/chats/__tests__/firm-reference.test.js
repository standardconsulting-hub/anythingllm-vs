// vs-fork Plan 4 §C.4c — firm-reference helper tests.
//
// Covers:
//   - Adaptive cap formula (Plan 4 v4 corrected;
//     docs/plans/2026-05-06-plan-4-brand-prompt-workflows.md:1582):
//       fr_cap = matter_hits < 2
//                ? 0
//                : min(floor(K/2), floor(matter_hits/2))
//   - 9 cap-table rows for K=4 from the v4 worked example
//     (m=[0..8] → fr_cap=[0,0,1,1,2,2,2,2,2]).
//   - 4 guard cases: workspace not opted in; sparse m=0;
//     sparse m=1; missing LLMConnector.
//   - MANIFEST.sha256 loader: present-file vs absent-file.
//   - Zero-result-after-retrieval (sub-plan v3 FLAG-1 +
//     v4 FLAG-3 closure): fr_cap > 0 but search returns
//     [] → manifest_sha is null even when the SHA file
//     exists on disk.
//
// Mocks `getVectorDbClass` so these tests exercise the
// helper in isolation without needing a live LanceDB
// instance. The MANIFEST tests use VS_FIRM_REFERENCE_DIR
// + an mkdtemp fixture to swap fixture paths between
// cases.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Mock getVectorDbClass — return a singleton with a
// jest.fn so each test can mockImplementationOnce or read
// the captured args via .mock.calls. Keeping the function
// stable across tests means the helper's
// `getVectorDbClass()` call always returns the same mock.
jest.mock("../../helpers", () => {
  const performSimilaritySearch = jest.fn();
  return {
    getVectorDbClass: jest.fn(() => ({ performSimilaritySearch })),
    __performSimilaritySearchMock: performSimilaritySearch,
  };
});

const helpersMock = require("../../helpers");
const performSimilaritySearch = helpersMock.__performSimilaritySearchMock;

const {
  fetchFirmReferenceChunks,
  loadFirmReferenceManifestSha,
  adaptiveCap,
  FIRM_REFERENCE_NAMESPACE,
  _resetCacheForTests,
} = require("../firm-reference");

// Test fixtures
const fakeLLM = {
  embedTextInput: async () => [0.1, 0.2, 0.3],
};

function workspace({ optedIn } = {}) {
  return {
    id: 42,
    slug: "matter-x",
    cross_workspace_with: optedIn ? FIRM_REFERENCE_NAMESPACE : null,
  };
}

function chunks(n) {
  return Array.from({ length: n }, (_, i) => ({ text: `m${i}` }));
}

function searchReturnWith(count) {
  return {
    contextTexts: Array.from({ length: count }, (_, i) => `fr-text-${i}`),
    sources: Array.from({ length: count }, (_, i) => ({
      metadata: { id: `fr-${i}` },
    })),
    message: false,
  };
}

beforeEach(() => {
  performSimilaritySearch.mockReset();
  performSimilaritySearch.mockResolvedValue({
    contextTexts: [],
    sources: [],
    message: false,
  });
  _resetCacheForTests();
  delete process.env.VS_FIRM_REFERENCE_DIR;
});

describe("adaptiveCap (Plan 4 v4 worked example, K=4)", () => {
  // Plan 4 v4 lines 1587-1596: the exact table.
  const cases = [
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 1],
    [4, 2],
    [5, 2],
    [6, 2],
    [7, 2],
    [8, 2],
  ];
  test.each(cases)(
    "matter_hits=%d → fr_cap=%d at K=4",
    (matterHits, expected) => {
      expect(adaptiveCap(matterHits, 4)).toBe(expected);
    }
  );

  test("k defaults to 4 when omitted", () => {
    expect(adaptiveCap(6)).toBe(2);
  });

  test("non-numeric matter_hits falls through to 0", () => {
    expect(adaptiveCap(null, 4)).toBe(0);
    expect(adaptiveCap("nope", 4)).toBe(0);
  });
});

describe("fetchFirmReferenceChunks — guards", () => {
  test("workspace without cross_workspace_with returns zero-count + null manifest", async () => {
    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: false }),
      input: "hello?",
      matterChunks: chunks(4),
      LLMConnector: fakeLLM,
    });
    expect(out).toEqual({ chunks: [], count: 0, manifest_sha: null });
    expect(performSimilaritySearch).not.toHaveBeenCalled();
  });

  test("opted-in workspace + matter_hits=0 returns zero-count (sparse-matter guard)", async () => {
    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: true }),
      input: "hello?",
      matterChunks: chunks(0),
      LLMConnector: fakeLLM,
    });
    expect(out).toEqual({ chunks: [], count: 0, manifest_sha: null });
    expect(performSimilaritySearch).not.toHaveBeenCalled();
  });

  test("opted-in workspace + matter_hits=1 returns zero-count (sparse-matter guard)", async () => {
    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: true }),
      input: "hello?",
      matterChunks: chunks(1),
      LLMConnector: fakeLLM,
    });
    expect(out).toEqual({ chunks: [], count: 0, manifest_sha: null });
    expect(performSimilaritySearch).not.toHaveBeenCalled();
  });

  test("missing LLMConnector returns zero-count (defensive guard)", async () => {
    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: true }),
      input: "hello?",
      matterChunks: chunks(4),
      LLMConnector: null,
    });
    expect(out).toEqual({ chunks: [], count: 0, manifest_sha: null });
    expect(performSimilaritySearch).not.toHaveBeenCalled();
  });
});

describe("fetchFirmReferenceChunks — retrieval", () => {
  test("opted-in workspace + matter_hits=4 + retrieval returns 2 → invokes performSimilaritySearch with topN=2 and returns 2 merged chunks", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fr-test-"));
    fs.writeFileSync(path.join(tmp, "MANIFEST.sha256"), "abc123\n");
    process.env.VS_FIRM_REFERENCE_DIR = tmp;

    performSimilaritySearch.mockResolvedValueOnce(searchReturnWith(2));
    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: true }),
      input: "what is the firm SOP for sensitive material?",
      matterChunks: chunks(4),
      similarityThreshold: 0.3,
      LLMConnector: fakeLLM,
    });

    expect(performSimilaritySearch).toHaveBeenCalledTimes(1);
    expect(performSimilaritySearch).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: FIRM_REFERENCE_NAMESPACE,
        input: "what is the firm SOP for sensitive material?",
        LLMConnector: fakeLLM,
        similarityThreshold: 0.3,
        topN: 2, // matches fr_cap for matter_hits=4 at K=4
      })
    );
    expect(out.count).toBe(2);
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks[0]).toEqual({
      text: "fr-text-0",
      source: { metadata: { id: "fr-0" } },
      workspace: FIRM_REFERENCE_NAMESPACE,
    });
    expect(out.manifest_sha).toBe("abc123");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("zero-result retrieval (sub-plan v3 FLAG-1 + v4 FLAG-3 closure): fr_cap > 0 but search returns [] → manifest_sha is null even when SHA file exists", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fr-test-"));
    fs.writeFileSync(path.join(tmp, "MANIFEST.sha256"), "deadbeef\n");
    process.env.VS_FIRM_REFERENCE_DIR = tmp;

    performSimilaritySearch.mockResolvedValueOnce(searchReturnWith(0));
    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: true }),
      input: "anything",
      matterChunks: chunks(4), // m=4, fr_cap=2
      LLMConnector: fakeLLM,
    });

    // Search WAS invoked (fr_cap>0 entered the retrieval
    // branch) — but count came back 0, so manifest_sha is
    // null per the audit semantics.
    expect(performSimilaritySearch).toHaveBeenCalledTimes(1);
    expect(performSimilaritySearch.mock.calls[0][0]).toMatchObject({
      topN: 2,
    });
    expect(out).toEqual({ chunks: [], count: 0, manifest_sha: null });

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("retrieval throws → fall back to zero-count without breaking the chat", async () => {
    performSimilaritySearch.mockRejectedValueOnce(new Error("retrieval blew up"));

    // Suppress the helper's defensive console.error for
    // this test only.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const out = await fetchFirmReferenceChunks({
      workspace: workspace({ optedIn: true }),
      input: "anything",
      matterChunks: chunks(4),
      LLMConnector: fakeLLM,
    });

    expect(out).toEqual({ chunks: [], count: 0, manifest_sha: null });
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe("loadFirmReferenceManifestSha", () => {
  test("returns null when MANIFEST.sha256 is absent", () => {
    process.env.VS_FIRM_REFERENCE_DIR = "/tmp/vs-no-fr-here";
    expect(loadFirmReferenceManifestSha()).toBeNull();
  });

  test("returns the trimmed SHA when MANIFEST.sha256 exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fr-test-"));
    fs.writeFileSync(
      path.join(tmp, "MANIFEST.sha256"),
      "  cafebabe1234  \n"
    );
    process.env.VS_FIRM_REFERENCE_DIR = tmp;

    expect(loadFirmReferenceManifestSha()).toBe("cafebabe1234");

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("caches the loaded SHA across calls", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-fr-test-"));
    fs.writeFileSync(path.join(tmp, "MANIFEST.sha256"), "first\n");
    process.env.VS_FIRM_REFERENCE_DIR = tmp;

    expect(loadFirmReferenceManifestSha()).toBe("first");

    // Even if the file changes, the cache should hold.
    fs.writeFileSync(path.join(tmp, "MANIFEST.sha256"), "second\n");
    expect(loadFirmReferenceManifestSha()).toBe("first");

    // Reset clears the cache and re-reads.
    _resetCacheForTests();
    expect(loadFirmReferenceManifestSha()).toBe("second");

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
