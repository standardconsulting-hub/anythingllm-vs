// vs-fork audit JSONL writer — Plan 1 Task 7 (TDD).
//
// The writer is the lowest layer of the audit chain. Day-stamped
// UTC files at <auditDir>/queries-YYYY-MM-DD.jsonl, fsync before
// resolve, 600 perms, parent-dir fsync on first create. Every
// promise the writer returns must imply the data is on stable
// storage (else a crash window between persist and audit could
// orphan a chat turn from its audit row, which spec §6.1 forbids).

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { makeAuditWriter } = require("../audit-writer");

describe("audit writer", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-audit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSONL line to the day-stamped file", async () => {
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await writer.write({
      ts: "2026-04-30T10:14:23Z",
      matter: "INQ-2026-001",
      user: "david",
      prompt: "hello",
      response: "world",
    });
    const file = path.join(tmpDir, "queries-2026-04-30.jsonl");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").trim());
    expect(parsed.matter).toBe("INQ-2026-001");
    expect(parsed.user).toBe("david");
    expect(parsed.response).toBe("world");
  });

  it("creates the JSONL file with mode 0600", async () => {
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await writer.write({ ts: "2026-04-30T00:00:00Z", note: "perms-test" });
    const file = path.join(tmpDir, "queries-2026-04-30.jsonl");
    const stat = fs.statSync(file);
    // & 0o777 strips the file-type bits; we only care about the
    // permission triplet. macOS/Linux both honour the umask, but
    // the writer passes 0o600 explicitly so the mode survives a
    // restrictive umask too.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rejects when the audit dir does not exist", async () => {
    const writer = makeAuditWriter({ auditDir: "/dev/null/nope" });
    await expect(
      writer.write({ ts: "2026-04-30T00:00:00Z" })
    ).rejects.toThrow();
  });

  it("appends rather than overwrites on second write", async () => {
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await writer.write({ ts: "2026-04-30T10:00:00Z", matter: "A" });
    await writer.write({ ts: "2026-04-30T11:00:00Z", matter: "B" });
    const lines = fs
      .readFileSync(path.join(tmpDir, "queries-2026-04-30.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).matter).toBe("A");
    expect(JSON.parse(lines[1]).matter).toBe("B");
  });

  it("rolls to a new day-stamped file on a date boundary", async () => {
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await writer.write({ ts: "2026-04-30T23:59:59Z", matter: "yday" });
    await writer.write({ ts: "2026-05-01T00:00:01Z", matter: "today" });
    expect(
      JSON.parse(
        fs
          .readFileSync(path.join(tmpDir, "queries-2026-04-30.jsonl"), "utf8")
          .trim()
      ).matter
    ).toBe("yday");
    expect(
      JSON.parse(
        fs
          .readFileSync(path.join(tmpDir, "queries-2026-05-01.jsonl"), "utf8")
          .trim()
      ).matter
    ).toBe("today");
  });

  it("day-stamps in UTC, not local time", async () => {
    // 2026-04-30T23:30:00Z is 2026-05-01 00:30 BST and 2026-04-30
    // 16:30 PDT — a writer that uses local time would split this
    // wrong on either coast. Writer must always day-stamp in UTC.
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await writer.write({ ts: "2026-04-30T23:30:00Z", note: "edge" });
    expect(
      fs.existsSync(path.join(tmpDir, "queries-2026-04-30.jsonl"))
    ).toBe(true);
  });

  it("resolves with the data already readable by an independent fd (fsync semantics)", async () => {
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await writer.write({
      ts: "2026-04-30T12:00:00Z",
      matter: "C",
      response: "fsync proof",
    });
    // Re-open from a fresh fd post-resolve. Any non-fsynced data
    // would be invisible to a process started right after a crash;
    // we cannot literally crash here, but reading from a fresh fd
    // exercises the same path the post-crash reader would take.
    const file = path.join(tmpDir, "queries-2026-04-30.jsonl");
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      expect(buf.slice(0, n).toString("utf8")).toContain('"matter":"C"');
    } finally {
      fs.closeSync(fd);
    }
  });

  it("serialises concurrent writes without interleaving", async () => {
    // Two writes scheduled at the same moment must not produce
    // a half-line / interleaved JSON file. The writer is allowed
    // to serialise internally; the test asserts the contract,
    // not the implementation.
    const writer = makeAuditWriter({ auditDir: tmpDir });
    await Promise.all([
      writer.write({ ts: "2026-04-30T10:00:00Z", matter: "A", filler: "x".repeat(2000) }),
      writer.write({ ts: "2026-04-30T10:00:00Z", matter: "B", filler: "y".repeat(2000) }),
      writer.write({ ts: "2026-04-30T10:00:00Z", matter: "C", filler: "z".repeat(2000) }),
    ]);
    const lines = fs
      .readFileSync(path.join(tmpDir, "queries-2026-04-30.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // Each line must parse cleanly. An interleaved write would
      // throw here.
      const parsed = JSON.parse(line);
      expect(["A", "B", "C"]).toContain(parsed.matter);
    }
  });
});
