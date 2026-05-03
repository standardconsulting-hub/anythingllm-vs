// vs-fork audit middleware — Plan 1 v5 Task 8 (TDD).
//
// auditAndPersist is the inline gatekeeper every LLM-completion
// handler will call (Tasks 9–11): audit FIRST, persist SECOND.
// If the audit succeeds but persistence fails, a durable fail-
// closed flag is written and every subsequent call refuses with
// 503 — process restart cannot quietly resume serving.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  auditAndPersist,
  AuditFailure,
  PersistFailure,
  FailClosedActive,
  failClosedFlagPath,
  newAuditId,
} = require("../audit-middleware");

describe("audit middleware — auditAndPersist", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-mw-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseRequest = {
    user: { id: 1, email: "david@varneystandard.co.uk" },
    body: { message: "what is the COFA's audit duty?" },
    params: { slug: "INQ-2026-001" },
  };
  const modelMeta = {
    model: "qwen2.5-72b-instruct-mlx-4bit@abc",
    system_prompt: "default-v1.0",
    embedding_model: "xenova/all-MiniLM-L6-v2@def",
    anythingllm_version: "1.12.1+vs",
    chunking: { chunk_tokens: 1000, overlap: 150, top_k: 8 },
    firm_reference_manifest: "sha-x",
    tokens_in: 81,
    tokens_out: 47,
    latency_ms: 897,
  };

  it("happy path: audit JSONL written, persistFn called with audit_id, entry returned", async () => {
    let receivedId = null;
    const persistFn = async (auditId) => {
      receivedId = auditId;
    };

    const entry = await auditAndPersist({
      auditDir: tmpDir,
      request: baseRequest,
      llmResponse: "hello world",
      retrievedChunks: [
        {
          source: "doc.pdf",
          source_sha256: "sha",
          pdf_page: 1,
          chunk_id: "c1",
        },
      ],
      modelMeta,
      workflow: "targeted_query",
      persistFn,
    });

    expect(entry.audit_id).toMatch(/^[0-9a-f]{12}-[0-9a-f]{16}$/);
    expect(receivedId).toBe(entry.audit_id);
    expect(entry.user).toBe("david@varneystandard.co.uk");
    expect(entry.matter).toBe("INQ-2026-001");
    expect(entry.response).toBe("hello world");
    expect(entry.workflow).toBe("targeted_query");
    expect(entry.tokens_out).toBe(47);

    // JSONL file matches what we returned.
    const today = new Date(entry.ts);
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const file = path.join(tmpDir, `queries-${yyyy}-${mm}-${dd}.jsonl`);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(persisted.audit_id).toBe(entry.audit_id);
  });

  it("audit failure (unwritable auditDir) → persistFn NOT called → AuditFailure thrown", async () => {
    let persisted = false;
    const persistFn = async () => {
      persisted = true;
    };

    await expect(
      auditAndPersist({
        auditDir: "/dev/null/nope",
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta,
        workflow: "targeted_query",
        persistFn,
      })
    ).rejects.toThrow(AuditFailure);

    expect(persisted).toBe(false);
  });

  it("persistFn failure after successful audit → writes _failclose.flag and throws PersistFailure", async () => {
    let persistAttempts = 0;
    const persistFn = async () => {
      persistAttempts++;
      throw new Error("sqlite full");
    };

    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta,
        workflow: "targeted_query",
        persistFn,
      })
    ).rejects.toThrow(PersistFailure);

    expect(persistAttempts).toBe(1);
    // The audit JSONL must still have been written (audit before persist).
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const file = path.join(tmpDir, `queries-${yyyy}-${mm}-${dd}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    // The fail-closed flag was written.
    expect(fs.existsSync(failClosedFlagPath(tmpDir))).toBe(true);
    const flag = JSON.parse(
      fs.readFileSync(failClosedFlagPath(tmpDir), "utf8")
    );
    expect(typeof flag.set_at).toBe("string");
    expect(flag.reason).toMatch(/persist|sqlite/i);
  });

  it("durable fail-closed: pre-existing flag → refuses without writing JSONL or calling persistFn", async () => {
    // Simulate the post-incident state: previous run set the flag,
    // process restarted, audit dir still has the flag on disk.
    fs.writeFileSync(
      failClosedFlagPath(tmpDir),
      JSON.stringify({
        set_at: "2026-04-30T10:00:00Z",
        reason: "test-induced fail-close",
        pid: 999,
      }),
      { mode: 0o600 }
    );

    let persisted = false;
    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta,
        workflow: "targeted_query",
        persistFn: async () => {
          persisted = true;
        },
      })
    ).rejects.toThrow(FailClosedActive);
    expect(persisted).toBe(false);

    // Crucially: no JSONL was written either. The whole audit
    // subsystem refuses to take new entries until the operator
    // clears the flag.
    const files = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("queries-"));
    expect(files).toEqual([]);
  });

  it("newAuditId has a non-regressing ms-prefix and is unique per call", async () => {
    // The format is `<12-hex ms timestamp>-<16-hex random>`. We
    // guarantee ms-prefix monotonicity (audit ordering by id at
    // ms granularity). Within the same ms the random suffix is
    // unordered by design — that's acceptable for v1; the JSONL
    // itself preserves arrival order via append-only, and the
    // audit_id prefix lets readers bucket by ms.
    const a = newAuditId();
    const b = newAuditId();
    const c = newAuditId();
    const prefix = (id) => id.split("-")[0];
    expect(prefix(a) <= prefix(b)).toBe(true);
    expect(prefix(b) <= prefix(c)).toBe(true);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
