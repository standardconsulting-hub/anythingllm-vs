// vs-fork Plan 4 §C BLOCK-1 — chat-surface tests for apiChatHandler.
//
// Exercises the dev-API non-streaming chat path (`chatSync`) end-to-
// end against the real audit middleware in a tmp audit dir, with
// mocked vector / LLM / persistence dependencies. Three scenarios
// per sub-plan v4 lines 742-772:
//
//   1. Category (i) cw_pass=true:  workspace opted in, ≥2 matter
//      hits, firm-reference helper returns chunks → audit row has
//      cw_pass:true, cross_workspace_with:["firm-reference"],
//      cross_workspace_chunks:>0, firm_reference_manifest:<sha>.
//   2. Category (i) cw_pass=false: workspace not opted in, helper
//      returns count:0 → audit row has cw_pass:false, no
//      cross_workspace_with key, no cross_workspace_chunks key,
//      firm_reference_manifest:null.
//   3. Category (iii) §5.3 sparse-matter refusal: empty workspace
//      + chatMode=query → JSONL row carries prompt, response,
//      cw_pass:false, no cross_workspace_*, no `kind` field
//      (chat rows omit `kind`; v3 FLAG-3 closure), AND the
//      `audit_id` written to JSONL matches the auditId received
//      by WorkspaceChats.new (the persistFn(auditId) bridge from
//      v2 BLOCK-1 closure).

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// utils/files/index.js resolves storage paths against
// STORAGE_DIR at require time (not at function call), so it
// must be set BEFORE we load apiChatHandler. The path itself
// doesn't have to exist for these tests — apiChatHandler only
// touches it for attachment processing, which we bypass by
// passing attachments: [].
process.env.STORAGE_DIR = process.env.STORAGE_DIR || os.tmpdir();
process.env.NODE_ENV = process.env.NODE_ENV || "test";

// ---------- Mocks (hoisted by jest.mock) ----------

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
  grepAllSlashCommands: jest.fn().mockImplementation(async (m) => m),
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

jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));

jest.mock("../../collectorApi", () => ({
  CollectorApi: class {
    async online() {
      return false;
    }
  },
}));

// ---------- Imports (after mocks) ----------

const helpers = require("../../helpers");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const firmRef = require("../firm-reference");
const { ApiChatHandler } = require("../apiChatHandler");
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
    getChatCompletion: async () => ({
      textResponse: "hello world",
      metrics: { prompt_tokens: 81, completion_tokens: 47 },
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

function jsonlPath(auditDir, ts) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return path.join(auditDir, `queries-${yyyy}-${mm}-${dd}.jsonl`);
}

function readLatestJsonl(auditDir) {
  const files = fs
    .readdirSync(auditDir)
    .filter((f) => f.startsWith("queries-") && f.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  files.sort();
  const last = files[files.length - 1];
  const lines = fs
    .readFileSync(path.join(auditDir, last), "utf8")
    .trim()
    .split("\n");
  return lines.map((l) => JSON.parse(l));
}

// ---------- Tests ----------

describe("apiChatHandler.chatSync — Plan 4 §C audit shape (BLOCK-1)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-chat-test-"));
    process.env.VS_AUDIT_DIR = tmpDir;
    _resetWritersForTests();

    helpers.getLLMProvider.mockReset();
    helpers.getVectorDbClass.mockReset();
    firmRef.fetchFirmReferenceChunks.mockReset();
    WorkspaceChats.new.mockReset();
    WorkspaceChats.new.mockResolvedValue({ chat: { id: 999 }, message: null });
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

    const result = await ApiChatHandler.chatSync({
      workspace: { ...baseWorkspace, cross_workspace_with: "firm-reference" },
      message: "what is the firm SOP for sensitive material?",
      mode: "chat",
      user: baseUser,
      thread: null,
      sessionId: "sess-1",
    });

    expect(result.type).toBe("textResponse");
    expect(result.textResponse).toBe("hello world");

    const rows = readLatestJsonl(tmpDir);
    expect(rows).toHaveLength(1);
    const audit = rows[0];

    expect(audit.cw_pass).toBe(true);
    expect(audit.cross_workspace_with).toEqual(["firm-reference"]);
    expect(audit.cross_workspace_chunks).toBe(2);
    expect(audit.firm_reference_manifest).toBe("sha-abc123");
    expect(audit.user).toBe(baseUser.email);
    expect(audit.matter).toBe(baseWorkspace.slug);
    expect(audit.workflow).toBe("open_chat");
    expect(audit.kind).toBeUndefined();
    expect(audit.audit_id).toMatch(/^[0-9a-f]{12}-[0-9a-f]{16}$/);

    expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
    expect(WorkspaceChats.new.mock.calls[0][0].auditId).toBe(audit.audit_id);
  });

  test("Category (i) cw_pass=false — non-opted-in workspace → audit row has cw_pass:false, no cross_workspace_with/chunks keys, manifest:null", async () => {
    helpers.getLLMProvider.mockReturnValue(makeLLMConnector());
    helpers.getVectorDbClass.mockReturnValue(makeVectorDb({ namespaceCount: 2, hits: 2 }));
    firmRef.fetchFirmReferenceChunks.mockResolvedValue({
      chunks: [],
      count: 0,
      manifest_sha: null,
    });

    await ApiChatHandler.chatSync({
      workspace: { ...baseWorkspace, cross_workspace_with: null },
      message: "anything",
      mode: "chat",
      user: baseUser,
      thread: null,
      sessionId: "sess-2",
    });

    const audit = readLatestJsonl(tmpDir)[0];

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
    // Helper should NOT be called on this refusal path; if it is,
    // that's a regression in the early-return at apiChatHandler.js:252.
    firmRef.fetchFirmReferenceChunks.mockResolvedValue({
      chunks: [],
      count: 0,
      manifest_sha: null,
    });

    const result = await ApiChatHandler.chatSync({
      workspace: { ...baseWorkspace, cross_workspace_with: "firm-reference" },
      message: "any question",
      mode: "query",
      user: baseUser,
      thread: null,
      sessionId: "sess-3",
    });

    expect(result.type).toBe("textResponse");
    expect(result.textResponse).toBe(baseWorkspace.queryRefusalResponse);

    const audit = readLatestJsonl(tmpDir)[0];

    expect(audit.prompt).toBe("any question");
    expect(audit.response).toBe(baseWorkspace.queryRefusalResponse);
    expect(audit.cw_pass).toBe(false);
    expect(audit.cross_workspace_with).toBeUndefined();
    expect(audit.cross_workspace_chunks).toBeUndefined();
    expect(audit.firm_reference_manifest).toBeNull();
    expect(audit.kind).toBeUndefined();
    expect(audit.workflow).toBe("targeted_query");

    expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
    expect(WorkspaceChats.new.mock.calls[0][0].auditId).toBe(audit.audit_id);
    expect(firmRef.fetchFirmReferenceChunks).not.toHaveBeenCalled();
  });
});
