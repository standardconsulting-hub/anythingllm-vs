// vs-fork Plan 2 §E — upload audit hook semantics.
//
// These tests exercise the `auditAndPersist({kind: "upload_*"})`
// shape. The route-level integration (multer cleanup,
// fail-closed flag write, response shape) is covered by a live
// smoke after this suite passes; encoding multer behaviour into
// a unit test would require mocking Express + multer which is
// not worth the test brittleness.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  auditAndPersist,
  AuditFailure,
  PersistFailure,
  FailClosedActive,
  failClosedFlagPath,
  _resetWritersForTests,
} = require("../audit-middleware");

describe("audit middleware — upload hook (Plan 2 §E)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-upload-test-"));
    _resetWritersForTests();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseRequest = {
    user: { id: 1, email: "david@standardconsulting.co.uk" },
    params: { slug: "INQ-2026-001" },
    body: {},
  };
  const baseUpload = {
    filename: "report.pdf",
    sha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    size_bytes: 12345,
    mime: "application/pdf",
    processor: "collector",
  };

  function readJsonl() {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const file = path.join(tmpDir, `queries-${yyyy}-${mm}-${dd}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("upload_attempt: writes a Row 1 with kind + filename + sha256, no persistFn called", async () => {
    let persistCalled = false;
    const entry = await auditAndPersist({
      auditDir: tmpDir,
      kind: "upload_attempt",
      request: baseRequest,
      upload: baseUpload,
      persistFn: async () => {
        persistCalled = true;
      },
    });

    expect(entry.kind).toBe("upload_attempt");
    expect(entry.filename).toBe("report.pdf");
    expect(entry.sha256).toBe(baseUpload.sha256);
    expect(entry.workspace_id).toBe("INQ-2026-001");
    expect(entry.user).toBe("david@standardconsulting.co.uk");
    expect(entry.audit_id).toMatch(/^[0-9a-f]{12}-[0-9a-f]{16}$/);

    // persistFn should NOT have been called for upload kinds.
    expect(persistCalled).toBe(false);

    // Exactly one row in the JSONL.
    const rows = readJsonl();
    expect(rows).toHaveLength(1);
    expect(rows[0].audit_id).toBe(entry.audit_id);
  });

  it("upload_outcome: shares audit_id with Row 1, contains outcome + duration_ms", async () => {
    const row1 = await auditAndPersist({
      auditDir: tmpDir,
      kind: "upload_attempt",
      request: baseRequest,
      upload: baseUpload,
    });

    const row2 = await auditAndPersist({
      auditDir: tmpDir,
      kind: "upload_outcome",
      auditId: row1.audit_id,
      uploadOutcome: {
        outcome: "success",
        duration_ms: 4445,
        collector_message: null,
      },
    });

    expect(row2.audit_id).toBe(row1.audit_id);
    expect(row2.kind).toBe("upload_outcome");
    expect(row2.outcome).toBe("success");
    expect(row2.duration_ms).toBe(4445);

    const rows = readJsonl();
    expect(rows).toHaveLength(2);
    expect(rows[0].audit_id).toBe(rows[1].audit_id);
    expect(rows[0].kind).toBe("upload_attempt");
    expect(rows[1].kind).toBe("upload_outcome");
  });

  it("upload_outcome without auditId throws (Row 2 must reuse Row 1's id)", async () => {
    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        kind: "upload_outcome",
        // no auditId
        uploadOutcome: { outcome: "success", duration_ms: 1 },
      })
    ).rejects.toThrow(/auditId/);

    expect(readJsonl()).toEqual([]);
  });

  it("upload_attempt without `upload` payload throws", async () => {
    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        kind: "upload_attempt",
        request: baseRequest,
        // no upload
      })
    ).rejects.toThrow(/upload.*payload/i);
  });

  it("pre-existing fail-closed flag refuses upload_attempt without writing JSONL", async () => {
    fs.writeFileSync(
      failClosedFlagPath(tmpDir),
      JSON.stringify({
        set_at: "2026-04-30T10:00:00Z",
        reason: "test fail-close",
        pid: 999,
      }),
      { mode: 0o600 }
    );

    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        kind: "upload_attempt",
        request: baseRequest,
        upload: baseUpload,
      })
    ).rejects.toThrow(FailClosedActive);

    // No JSONL written, just the flag.
    const rows = readJsonl();
    expect(rows).toEqual([]);
  });

  it("upload_outcome failure (writer breaks) bubbles AuditFailure (caller writes flag)", async () => {
    const row1 = await auditAndPersist({
      auditDir: tmpDir,
      kind: "upload_attempt",
      request: baseRequest,
      upload: baseUpload,
    });

    // Make the audit dir unwritable so the next write fails.
    // Note: we delete the dir entirely so the writer's open()
    // throws ENOENT.
    fs.rmSync(tmpDir, { recursive: true, force: true });

    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        kind: "upload_outcome",
        auditId: row1.audit_id,
        uploadOutcome: { outcome: "success", duration_ms: 1 },
      })
    ).rejects.toThrow(AuditFailure);
  });

  it("rejects unknown kinds explicitly", async () => {
    await expect(
      auditAndPersist({
        auditDir: tmpDir,
        kind: "exfiltrate_everything",
        request: baseRequest,
      })
    ).rejects.toThrow(/unknown kind/);
  });
});
