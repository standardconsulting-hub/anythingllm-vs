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
  _resetWritersForTests,
} = require("../audit-middleware");

describe("audit middleware — auditAndPersist", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-mw-test-"));
    // BLOCK 4 fix: writers are now cached per auditDir. Each test
    // mints a fresh tmp dir, so we reset the cache to avoid bleed.
    _resetWritersForTests();
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

  // Plan 1 v5.1 BLOCK 4 fix — singleton writer per auditDir.
  // Concurrent calls share the same in-process serialisation queue
  // so two interleaved auditAndPersist invocations cannot race.
  it("BLOCK 4: concurrent auditAndPersist calls share one serialisation queue per auditDir", async () => {
    const persistFn = async () => {};
    const calls = Array.from({ length: 12 }).map((_, i) =>
      auditAndPersist({
        auditDir: tmpDir,
        request: { ...baseRequest, body: { message: `m${i}` } },
        llmResponse: `r${i}`,
        retrievedChunks: [],
        modelMeta,
        workflow: "open_chat",
        persistFn,
      })
    );
    const entries = await Promise.all(calls);

    // Every audit_id is unique.
    const ids = entries.map((e) => e.audit_id);
    expect(new Set(ids).size).toBe(12);

    // The JSONL file has exactly 12 well-formed lines (no
    // interleaved JSON, no orphan bytes). If the per-request
    // writer regression returned, parallel writes against the
    // same fd could split mid-line.
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const file = path.join(tmpDir, `queries-${yyyy}-${mm}-${dd}.jsonl`);
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length);
    expect(lines).toHaveLength(12);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // Plan 1 v5.1 BLOCK 1 fix — persistFn rejection path. Callers
  // are expected to inspect WorkspaceChats.new()'s `{chat, message}`
  // shape and throw on failure; we verify auditAndPersist's
  // contract under that shape.
  it("BLOCK 1: persistFn that throws still triggers fail-closed flag", async () => {
    const persistFn = async () => {
      // Mirror the real persistFn shape: caller throws when
      // WorkspaceChats.new returns { chat: null, message: ... }.
      throw new Error("WorkspaceChats.new failed: UNIQUE constraint x");
    };

    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta,
        workflow: "open_chat",
        persistFn,
      })
    ).rejects.toThrow(PersistFailure);

    expect(fs.existsSync(failClosedFlagPath(tmpDir))).toBe(true);
  });

  // Plan 1 v5.1 BLOCK 5 fix — if writeFailClosedFlag itself fails,
  // we cannot prove the next request will refuse, so the audit
  // subsystem's state is undefined. The only safe response is hard
  // exit. Test mocks process.exit via the underscore hook.
  it("BLOCK 5: if fail-closed flag cannot be written, process aborts", async () => {
    // Make the auditDir read-only AFTER the JSONL has been written.
    // The tricky bit: writer needs to succeed, then writeFailClosedFlag
    // needs to fail. We do this by chmod 0500 the dir before persistFn
    // runs (the JSONL fd is already open). Actually simpler: we let
    // the writer succeed normally, then point writeFailClosedFlag at
    // an unwritable subdir by setting auditDir to that subdir AFTER
    // the writer is cached.
    //
    // Cleanest: mock process.exit and arrange persistFn to throw,
    // then make the flag dir unwritable just before flag-write.
    const exited = [];
    auditAndPersist._onUnflushableFailClose = (code) => exited.push(code);

    // Write the JSONL successfully, then chmod the dir to 0500 so
    // the subsequent flag write fails.
    const persistFn = async () => {
      fs.chmodSync(tmpDir, 0o500);
      throw new Error("sqlite full");
    };

    try {
      await expect(
        auditAndPersist({
          auditDir: tmpDir,
          request: baseRequest,
          llmResponse: "hello",
          retrievedChunks: [],
          modelMeta,
          workflow: "open_chat",
          persistFn,
        })
      ).rejects.toThrow(PersistFailure);
      expect(exited).toEqual([1]);
    } finally {
      // Restore so afterEach's rmSync can clean up.
      try {
        fs.chmodSync(tmpDir, 0o700);
      } catch {
        /* ignore */
      }
      delete auditAndPersist._onUnflushableFailClose;
    }
  });

  // §E.2 commit 4 — citation_check schema bump. Was a static
  // string "not_applicable_v1"; is now a boolean | null sourced
  // from modelMeta.citation_check_shape. JSONL is append-only,
  // so legacy rows on disk keep the string forever and the
  // analyser (Plan 6 §8.5 vs-acceptance-audit) tolerates BOTH
  // shapes. These tests cover the new write path only.
  describe("citation_check schema (Plan 4 §E.2 commit 4)", () => {
    it("emits boolean true when modelMeta.citation_check_shape is true", async () => {
      const entry = await auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta: { ...modelMeta, citation_check_shape: true },
        workflow: "targeted_query",
        persistFn: async () => {},
      });
      expect(entry.citation_check).toBe(true);
      // Persisted JSONL row matches.
      const today = new Date(entry.ts);
      const yyyy = today.getUTCFullYear();
      const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(today.getUTCDate()).padStart(2, "0");
      const file = path.join(tmpDir, `queries-${yyyy}-${mm}-${dd}.jsonl`);
      const persisted = JSON.parse(fs.readFileSync(file, "utf8").trim());
      expect(persisted.citation_check).toBe(true);
    });

    it("emits boolean false when modelMeta.citation_check_shape is false", async () => {
      const entry = await auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta: { ...modelMeta, citation_check_shape: false },
        workflow: "targeted_query",
        persistFn: async () => {},
      });
      expect(entry.citation_check).toBe(false);
    });

    it("emits null when modelMeta.citation_check_shape is undefined (caller opted out)", async () => {
      // The agent_rejected paths in apiChatHandler never run
      // runCitationPostcheck because no LLM completion happens.
      // They omit citation_check_shape; the audit row should
      // record null rather than a stale "not_applicable_v1".
      const entry = await auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "rejected",
        retrievedChunks: [],
        modelMeta, // no citation_check_shape key
        workflow: "agent_rejected",
        persistFn: async () => {},
      });
      expect(entry.citation_check).toBeNull();
    });

    it("emits null when modelMeta.citation_check_shape is a non-boolean (string, number, null)", async () => {
      // Defensive: only typeof === "boolean" maps through. A
      // mis-typed caller (e.g. legacy code that passed the v1
      // string sentinel) gets coerced to null rather than
      // contaminating the JSONL with a non-boolean.
      const cases = ["not_applicable_v1", 0, 1, null, undefined];
      for (const v of cases) {
        const entry = await auditAndPersist({
          auditDir: tmpDir,
          request: baseRequest,
          llmResponse: "hello",
          retrievedChunks: [],
          modelMeta: { ...modelMeta, citation_check_shape: v },
          workflow: "targeted_query",
          persistFn: async () => {},
        });
        expect(entry.citation_check).toBeNull();
      }
    });

    it("does NOT emit the legacy 'not_applicable_v1' string on any post-§E.2 row", async () => {
      const entry = await auditAndPersist({
        auditDir: tmpDir,
        request: baseRequest,
        llmResponse: "hello",
        retrievedChunks: [],
        modelMeta: { ...modelMeta, citation_check_shape: true },
        workflow: "targeted_query",
        persistFn: async () => {},
      });
      expect(entry.citation_check).not.toBe("not_applicable_v1");
    });
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
