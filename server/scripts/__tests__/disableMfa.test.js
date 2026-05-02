// vs-fork Plan 1.5 v1.2.1 Task 9.1.
//
// Two layers of coverage:
//   1. In-process: import disableMfa() directly, assert DB
//      state + audit-log content (fastest; covers the actual
//      recovery semantics).
//   2. Subprocess: spawn the script with the user's stdin, feed
//      "DELETE\n", assert exit code 0 + DB state. This proves
//      the interactive gate is wired correctly and that the
//      script-as-shipped (not just the exported function) runs
//      end to end.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const prisma = require("../../utils/prisma");
const { UserBackupCode } = require("../../models/userBackupCode");
const { UserSession } = require("../../models/userSession");
const { disableMfa } = require("../disable-mfa");

let tmpLogDir;
let testUserIds = [];

beforeAll(() => {
  tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-recovery-"));
  process.env.VS_RECOVERY_LOG_PATH = path.join(tmpLogDir, "recovery.log");
});

afterAll(async () => {
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
  delete process.env.VS_RECOVERY_LOG_PATH;
  await prisma.$disconnect();
});

afterEach(async () => {
  if (testUserIds.length) {
    await prisma.user_backup_codes.deleteMany({
      where: { user_id: { in: testUserIds } },
    });
    await prisma.user_sessions.deleteMany({
      where: { user_id: { in: testUserIds } },
    });
    await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
    testUserIds = [];
  }
  // Truncate the recovery log between tests.
  try {
    fs.writeFileSync(process.env.VS_RECOVERY_LOG_PATH, "");
  } catch {
    /* swallow */
  }
});

async function makeMfaUser() {
  const username = `vs-recov-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const u = await prisma.users.create({
    data: {
      username,
      password: "irrelevant",
      totp_secret_ciphertext: "ciphertext-bytes",
      totp_verified_at: new Date(),
      totp_last_used_counter: 12345n,
      mfa_failed_attempt_count: 3,
      mfa_failed_window_start: new Date(),
      mfa_lockout_until: new Date(Date.now() + 15 * 60_000),
      must_rotate_password: false,
    },
  });
  testUserIds.push(u.id);
  // Seed backup codes + an active session to exercise the wipes.
  await UserBackupCode.seed(u.id, ["hash-a", "hash-b", "hash-c"]);
  const s = await UserSession.create({ userId: u.id });
  return { user: u, sessionId: s.id };
}

describe("disable-mfa.js (in-process)", () => {
  it("wipes MFA state, revokes sessions, forces password rotation, appends audit", async () => {
    const { user, sessionId } = await makeMfaUser();
    const result = await disableMfa(user.id, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.revoked).toBe(1);

    const after = await prisma.users.findUnique({ where: { id: user.id } });
    expect(after.totp_secret_ciphertext).toBeNull();
    expect(after.totp_verified_at).toBeNull();
    expect(after.totp_last_used_counter).toBeNull();
    expect(after.mfa_failed_attempt_count).toBe(0);
    expect(after.mfa_failed_window_start).toBeNull();
    expect(after.mfa_lockout_until).toBeNull();
    expect(after.must_rotate_password).toBe(true);

    expect(await UserBackupCode.countUnused(user.id)).toBe(0);
    const session = await prisma.user_sessions.findUnique({
      where: { id: sessionId },
    });
    expect(session.revoked_at).not.toBeNull();
    expect(session.revocation_reason).toBe("disable_mfa_recovery");

    const log = fs.readFileSync(process.env.VS_RECOVERY_LOG_PATH, "utf8");
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe("mfa_disabled_via_recovery_script");
    expect(event.user_id).toBe(user.id);
    expect(event.username).toBe(user.username);
    expect(event.revoked_sessions).toBe(1);
    expect(typeof event.actor_uid).toBe("number");
    expect(typeof event.at).toBe("string");
  });

  it("returns code=2 for unknown user id and writes nothing", async () => {
    const result = await disableMfa(9_999_999, { confirmed: true });
    expect(result).toEqual({ ok: false, code: 2 });
    expect(fs.readFileSync(process.env.VS_RECOVERY_LOG_PATH, "utf8")).toBe("");
  });
});

describe("disable-mfa.js (subprocess)", () => {
  it("prompts for DELETE, executes on match, exits 0", async () => {
    const { user } = await makeMfaUser();
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "..", "disable-mfa.js"), String(user.id)],
      {
        cwd: path.resolve(__dirname, "..", ".."),
        env: {
          ...process.env,
          VS_RECOVERY_LOG_PATH: process.env.VS_RECOVERY_LOG_PATH,
        },
      }
    );
    child.stdin.write("DELETE\n");
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(stdout).toMatch(/MFA disabled/);
    expect(stderr).toBe("");

    const after = await prisma.users.findUnique({ where: { id: user.id } });
    expect(after.must_rotate_password).toBe(true);
    expect(after.totp_verified_at).toBeNull();
  }, 20_000);

  it("aborts (exits 1) when user does not type DELETE", async () => {
    const { user } = await makeMfaUser();
    const before = await prisma.users.findUnique({ where: { id: user.id } });
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, "..", "disable-mfa.js"), String(user.id)],
      {
        cwd: path.resolve(__dirname, "..", ".."),
        env: {
          ...process.env,
          VS_RECOVERY_LOG_PATH: process.env.VS_RECOVERY_LOG_PATH,
        },
      }
    );
    child.stdin.write("no\n");
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(1);
    const after = await prisma.users.findUnique({ where: { id: user.id } });
    expect(after.totp_verified_at).toEqual(before.totp_verified_at);
    expect(after.must_rotate_password).toBe(false);
  }, 20_000);
});
