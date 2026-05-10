// Tests for the Plan 4 §E.2 Commit 1 citation post-check helper.
//
// Each test stages a fixture script under a tmp dir and points
// the helper at it via the `scriptPath` option, so the tests do
// NOT depend on Python being on PATH or on the operator's
// plan-1-foundation checkout being present.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runCitationPostcheck } = require("../citation-postcheck");

function writeFixtureScript(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { encoding: "utf8", mode: 0o755 });
  return p;
}

const SHEBANG = "#!/bin/sh\n";

describe("runCitationPostcheck", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-citation-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("(a) clean output → ok: true, no flagged sentences", async () => {
    const script = writeFixtureScript(
      tmpDir,
      "clean.sh",
      SHEBANG +
        `echo '{"ok": true, "flagged_sentences": [], "warnings": []}'\n`
    );
    const result = await runCitationPostcheck("any text", {
      scriptPath: script,
    });
    expect(result.ok).toBe(true);
    expect(result.flagged_sentences).toEqual([]);
    expect(result.reason).toBeNull();
  });

  test("(b) flagged-but-no-citation → ok: false, sentences captured, reason: 'flagged'", async () => {
    const flaggedJson = JSON.stringify({
      ok: false,
      flagged_sentences: [
        "The witness stated the call was logged at 14:32.",
        "On the morning of 27 March 2026 the patient was admitted.",
      ],
      warnings: ["2 factual-style sentence(s) lack a citation"],
    });
    const script = writeFixtureScript(
      tmpDir,
      "flagged.sh",
      SHEBANG + `cat <<'JSON'\n${flaggedJson}\nJSON\n`
    );
    const result = await runCitationPostcheck("any text", {
      scriptPath: script,
    });
    expect(result.ok).toBe(false);
    expect(result.flagged_sentences).toHaveLength(2);
    expect(result.flagged_sentences[0]).toMatch(/witness stated/);
    expect(result.reason).toBe("flagged");
  });

  test("(c) malformed Python error → ok: false, reason: 'script_error', stderr captured", async () => {
    const script = writeFixtureScript(
      tmpDir,
      "crash.sh",
      SHEBANG +
        "echo 'Traceback (most recent call last):' >&2\n" +
        "echo '  File \"<stdin>\", line 5, in <module>' >&2\n" +
        "echo 'NameError: name x is not defined' >&2\n" +
        "exit 1\n"
    );
    const result = await runCitationPostcheck("any text", {
      scriptPath: script,
    });
    expect(result.ok).toBe(false);
    expect(result.flagged_sentences).toEqual([]);
    expect(result.reason).toBe("script_error");
    expect(result.error).toMatch(/Traceback|NameError/);
  });

  test("(d) timeout → ok: false, reason: 'timeout', child killed", async () => {
    const script = writeFixtureScript(
      tmpDir,
      "hang.sh",
      SHEBANG + "sleep 30\n"
    );
    const start = Date.now();
    const result = await runCitationPostcheck("any text", {
      scriptPath: script,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.flagged_sentences).toEqual([]);
    expect(result.reason).toBe("timeout");
    expect(result.error).toMatch(/exceeded 200ms/);
    // Helper must not wait for the full 30s sleep.
    expect(elapsed).toBeLessThan(2000);
  });

  test("(e) invalid JSON output → ok: false, reason: 'invalid_output'", async () => {
    const script = writeFixtureScript(
      tmpDir,
      "garbage.sh",
      SHEBANG + "echo 'not-json-at-all'\n"
    );
    const result = await runCitationPostcheck("any text", {
      scriptPath: script,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_output");
    expect(result.error).toMatch(/JSON parse failed/);
  });

  test("(f) no script configured → ok: false, reason: 'no_script'", async () => {
    const previous = process.env.VS_CITATION_POSTCHECK_SCRIPT;
    delete process.env.VS_CITATION_POSTCHECK_SCRIPT;
    try {
      const result = await runCitationPostcheck("any text");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no_script");
      expect(result.error).toMatch(/VS_CITATION_POSTCHECK_SCRIPT/);
    } finally {
      if (previous !== undefined)
        process.env.VS_CITATION_POSTCHECK_SCRIPT = previous;
    }
  });

  test("(g) env var honoured when scriptPath option absent", async () => {
    const script = writeFixtureScript(
      tmpDir,
      "env.sh",
      SHEBANG +
        `echo '{"ok": true, "flagged_sentences": [], "warnings": []}'\n`
    );
    const previous = process.env.VS_CITATION_POSTCHECK_SCRIPT;
    process.env.VS_CITATION_POSTCHECK_SCRIPT = script;
    try {
      const result = await runCitationPostcheck("any text");
      expect(result.ok).toBe(true);
    } finally {
      if (previous === undefined)
        delete process.env.VS_CITATION_POSTCHECK_SCRIPT;
      else process.env.VS_CITATION_POSTCHECK_SCRIPT = previous;
    }
  });
});
