// vs-fork Plan 4 §C BLOCK-1 — chat-surface tests for stream.js
// (browser-stream surface).
//
// Mirrors apiChatHandler.test.js with the same three Plan 4 §C
// scenarios — Category (i) cw_pass=true, Category (i) cw_pass=false,
// Category (iii) §5.3 sparse-matter refusal — adjusted for the
// streaming surface:
//
//   - takes a `response` object first; we stub it with a
//     write-chunk capture
//   - LLMConnector.streamingEnabled() returns false in the stub so
//     the non-streaming completion branch runs (avoids having to
//     mock handleStream / streamGetChatCompletion); the audit path
//     is identical regardless of which branch produced completeText
//   - audit modelMeta has `streamed: true`
//   - workflow detection from leading slash-command token (so a
//     plain "anything" message yields "open_chat" / "targeted_query"
//     just like apiChatHandler)
//
// Cross-references the matter-side updatedMessage usage at
// stream.js:262 — the BLOCK-3 regression guard at
// stream-firm-reference-regression.test.js asserts the call site
// statically; this test exercises the runtime contract.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.STORAGE_DIR = process.env.STORAGE_DIR || os.tmpdir();
process.env.NODE_ENV = process.env.NODE_ENV || "test";

// ---------- Mocks ----------

jest.mock("../../helpers", () => ({
  getLLMProvider: jest.fn(),
  getVectorDbClass: jest.fn(),
}));

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(),
    markThreadHistoryInvalidV2: jest.fn(),
  },
}));

jest.mock("../../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: {
    getContextFiles: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock("../firm-reference", () => ({
  fetchFirmReferenceChunks: jest.fn(),
  FIRM_REFERENCE_NAMESPACE: "firm-reference",
}));

jest.mock("../index", () => ({
  chatPrompt: jest.fn().mockResolvedValue("system prompt"),
  sourceIdentifier: jest.fn(() => "src-id"),
  recentChatHistory: jest.fn().mockResolvedValue({
    rawHistory: [],
    chatHistory: [],
  }),
  // grepCommand returns a DIFFERENT value than the input so the
  // cw_pass=true scenario can prove at runtime — not just by
  // static analysis — that fetchFirmReferenceChunks received the
  // post-grepCommand text. Closeout review FLAG-1: the original
  // pass-through mock would have let BLOCK-3 quietly re-emerge
  // because the helper-saw-the-raw-literal assertion held under
  // both correct and broken behaviours.
  grepCommand: jest
    .fn()
    .mockImplementation(async (m) => `expanded:${m}`),
  VALID_COMMANDS: {},
}));

jest.mock("../apiChatHandler", () => ({
  isAgentRequest: jest.fn(() => false),
}));

jest.mock("../../audit/citation-postcheck", () => ({
  runCitationPostcheck: jest.fn().mockResolvedValue({
    ok: true,
    flagged_sentences: [],
    reason: null,
  }),
}));

jest.mock("../../DocumentManager", () => ({
  DocumentManager: class {
    constructor() {}
    pinnedDocs() {
      return Promise.resolve([]);
    }
  },
}));

jest.mock("../../helpers/chat", () => ({
  fillSourceWindow: jest.fn(() => ({ contextTexts: [], sources: [] })),
}));

jest.mock("../../helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn(),
}));

// ---------- Imports ----------

const helpers = require("../../helpers");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const firmRef = require("../firm-reference");
const { writeResponseChunk } = require("../../helpers/chat/responses");
const { streamChatWithWorkspace } = require("../stream");
const { _resetWritersForTests } = require("../../audit/audit-middleware");

// ---------- Fixtures ----------

const baseWorkspace = {
  id: 42,
  slug: "INQ-2026-001",
  chatMode: "automatic",
  chatProvider: "openai",
  chatModel: "qwen2.5-72b-instruct-mlx-4bit",
  openAiTemp: 0.7,
  openAiHistory: 20,
  openAiPrompt: null,
  similarityThreshold: 0.25,
  topN: 4,
  vectorSearchMode: "default",
  queryRefusalResponse: "There is no relevant information in this workspace.",
  cross_workspace_with: null,
};

const baseUser = { id: 1, email: "david@varneystandard.co.uk", username: "david" };

function makeLLMConnector() {
  return {
    model: "qwen2.5-72b-instruct-mlx-4bit",
    defaultTemp: 0.7,
    promptWindowLimit: () => 32000,
    embedTextInput: async () => [0.1, 0.2, 0.3],
    compressMessages: async () => [{ role: "user", content: "hi" }],
    // Force the non-streaming branch so we don't have to stub
    // handleStream / streamGetChatCompletion.
    streamingEnabled: () => false,
    getChatCompletion: async () => ({
      textResponse: "hello world",
      metrics: { prompt_tokens: 81, completion_tokens: 47, duration: 0.5 },
    }),
  };
}

function makeVectorDb({ namespaceCount = 2, hits = 2 } = {}) {
  const sources = Array.from({ length: hits }, (_, i) => ({
    text: `chunk-${i}`,
    metadata: { id: `m-${i}` },
  }));
  return {
    hasNamespace: async () => namespaceCount > 0,
    namespaceCount: async () => namespaceCount,
    performSimilaritySearch: async () => ({
      contextTexts: sources.map((s) => s.text),
      sources,
      message: null,
    }),
  };
}

function makeResponseStub() {
  // streamChatWithWorkspace passes this object straight to
  // writeResponseChunk (mocked) and to handleStream (skipped via
  // streamingEnabled=false). It just needs to be a present
  // truthy object.
  return { __responseStub: true };
}

function readLatestJsonl(auditDir) {
  const files = fs
    .readdirSync(auditDir)
    .filter((f) => f.startsWith("queries-") && f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  files.sort();
  return fs
    .readFileSync(path.join(auditDir, files[files.length - 1]), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

// ---------- Tests ----------

describe("streamChatWithWorkspace — Plan 4 §C audit shape (BLOCK-1)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-stream-test-"));
    process.env.VS_AUDIT_DIR = tmpDir;
    _resetWritersForTests();

    helpers.getLLMProvider.mockReset();
    helpers.getVectorDbClass.mockReset();
    firmRef.fetchFirmReferenceChunks.mockReset();
    WorkspaceChats.new.mockReset();
    WorkspaceChats.new.mockResolvedValue({ chat: { id: 999 }, message: null });
    writeResponseChunk.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.VS_AUDIT_DIR;
  });

  test("Category (i) cw_pass=true — opted-in workspace + ≥2 matter hits + firm-ref chunks → audit row carries cross-workspace fields + manifest_sha", async () => {
    helpers.getLLMProvider.mockReturnValue(makeLLMConnector());
    helpers.getVectorDbClass.mockReturnValue(makeVectorDb({ namespaceCount: 2, hits: 2 }));
    firmRef.fetchFirmReferenceChunks.mockResolvedValue({
      chunks: [
        { text: "fr-0", source: { metadata: { id: "fr-0" } }, workspace: "firm-reference" },
        { text: "fr-1", source: { metadata: { id: "fr-1" } }, workspace: "firm-reference" },
      ],
      count: 2,
      manifest_sha: "sha-abc123",
    });

    await streamChatWithWorkspace(
      makeResponseStub(),
      { ...baseWorkspace, cross_workspace_with: "firm-reference" },
      "what is the firm SOP for sensitive material?",
      "chat",
      baseUser,
      null,
      []
    );

    const rows = readLatestJsonl(tmpDir);
    expect(rows).toHaveLength(1);
    const audit = rows[0];
    expect(audit.cw_pass).toBe(true);
    expect(audit.cross_workspace_with).toEqual(["firm-reference"]);
    expect(audit.cross_workspace_chunks).toBe(2);
    expect(audit.firm_reference_manifest).toBe("sha-abc123");
    expect(audit.workflow).toBe("open_chat");
    expect(audit.kind).toBeUndefined();

    expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
    expect(WorkspaceChats.new.mock.calls[0][0].auditId).toBe(audit.audit_id);

    // Runtime BLOCK-3 assertion: the grepCommand mock returns
    // `expanded:${message}` (see jest.mock("../index") above), so
    // the helper MUST have been called with that distinct expanded
    // value — not the raw message. If a future edit reverts the
    // call site to `input: message`, this assertion fails loudly
    // alongside the static regression guard at
    // stream-firm-reference-regression.test.js. (Closeout FLAG-1
    // closure.)
    expect(firmRef.fetchFirmReferenceChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "expanded:what is the firm SOP for sensitive material?",
      })
    );
  });

  test("Category (i) cw_pass=false — non-opted-in workspace → audit row has cw_pass:false, no cross_workspace_*, manifest:null", async () => {
    helpers.getLLMProvider.mockReturnValue(makeLLMConnector());
    helpers.getVectorDbClass.mockReturnValue(makeVectorDb({ namespaceCount: 2, hits: 2 }));
    firmRef.fetchFirmReferenceChunks.mockResolvedValue({
      chunks: [],
      count: 0,
      manifest_sha: null,
    });

    await streamChatWithWorkspace(
      makeResponseStub(),
      { ...baseWorkspace, cross_workspace_with: null },
      "anything",
      "chat",
      baseUser,
      null,
      []
    );

    const rows = readLatestJsonl(tmpDir);
    expect(rows).toHaveLength(1);
    const audit = rows[0];
    expect(audit.cw_pass).toBe(false);
    expect(audit.cross_workspace_with).toBeUndefined();
    expect(audit.cross_workspace_chunks).toBeUndefined();
    expect(audit.firm_reference_manifest).toBeNull();
    expect(audit.kind).toBeUndefined();

    expect(WorkspaceChats.new.mock.calls[0][0].auditId).toBe(audit.audit_id);
  });

  test("Category (iii) §5.3 sparse-matter refusal — empty workspace + query mode → audit row + WorkspaceChats share audit_id; no cross_workspace_*; no `kind`", async () => {
    helpers.getLLMProvider.mockReturnValue(makeLLMConnector());
    helpers.getVectorDbClass.mockReturnValue(makeVectorDb({ namespaceCount: 0, hits: 0 }));
    firmRef.fetchFirmReferenceChunks.mockResolvedValue({
      chunks: [],
      count: 0,
      manifest_sha: null,
    });

    await streamChatWithWorkspace(
      makeResponseStub(),
      { ...baseWorkspace, cross_workspace_with: "firm-reference" },
      "any question",
      "query",
      baseUser,
      null,
      []
    );

    const rows = readLatestJsonl(tmpDir);
    expect(rows).toHaveLength(1);
    const audit = rows[0];
    // stream.js's §5.3 refusal audit uses `body: { message:
    // updatedMessage }` (stream.js:149) — i.e. the post-grepCommand
    // form, which is the established browser-stream contract. The
    // grepCommand mock prepends "expanded:", so the audit prompt
    // reflects the expanded text. (The dev-API surface in
    // apiChatHandler does NOT run grepCommand, so its §5.3 audit
    // sees the raw message.)
    expect(audit.prompt).toBe("expanded:any question");
    expect(audit.response).toBe(baseWorkspace.queryRefusalResponse);
    expect(audit.cw_pass).toBe(false);
    expect(audit.cross_workspace_with).toBeUndefined();
    expect(audit.cross_workspace_chunks).toBeUndefined();
    expect(audit.firm_reference_manifest).toBeNull();
    expect(audit.workflow).toBe("targeted_query");
    expect(audit.kind).toBeUndefined();

    expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
    expect(WorkspaceChats.new.mock.calls[0][0].auditId).toBe(audit.audit_id);
    // Helper short-circuits on the early empty-namespace branch
    // — never called.
    expect(firmRef.fetchFirmReferenceChunks).not.toHaveBeenCalled();

    // The refusal must have been written to the response stream.
    expect(writeResponseChunk).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        type: "textResponse",
        textResponse: baseWorkspace.queryRefusalResponse,
      })
    );
  });
});
