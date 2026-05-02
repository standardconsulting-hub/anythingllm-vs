// vs-fork Plan 1.5 v1.2.1 Task 9.1.
//
// revoke-user-sessions: lighter variant. Sessions revoked +
// must_rotate_password=true, but MFA secret + backup codes
// must survive (closes Codex v1.1 FLAG #2).

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
const { revokeUserSessions } = require("../revoke-user-sessions");

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
  try {
    fs.writeFileSync(process.env.VS_RECOVERY_LOG_PATH, "");
  } catch {
    /* swallow */
  }
});

async function makeMfaUser() {
  const username = `vs-revoke-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const u = await prisma.users.create({
    data: {
      username,
      password: "irrelevant",
      totp_secret_ciphertext: "ciphertext-bytes",
      totp_verified_at: new Date(),
      totp_last_used_counter: 12345n,
      must_rotate_password: false,
    },
  });
  testUserIds.push(u.id);
  await UserBackupCode.seed(u.id, ["hash-a", "hash-b"]);
  const s1 = await UserSession.create({ userId: u.id });
  const s2 = await UserSession.create({ userId: u.id });
  return { user: u, sessionIds: [s1.id, s2.id] };
}

describe("revoke-user-sessions.js (in-process)", () => {
  it("revokes sessions, forces password rotation, preserves MFA secret + codes", async () => {
    const { user, sessionIds } = await makeMfaUser();
    const result = await revokeUserSessions(user.id, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.revoked).toBe(2);

    const after = await prisma.users.findUnique({ where: { id: user.id } });
    expect(after.totp_secret_ciphertext).toBe("ciphertext-bytes");
    expect(after.totp_verified_at).not.toBeNull();
    expect(after.totp_last_used_counter).toBe(12345n);
    expect(after.must_rotate_password).toBe(true);

    expect(await UserBackupCode.countUnused(user.id)).toBe(2);

    for (const sid of sessionIds) {
      const s = await prisma.user_sessions.findUnique({ where: { id: sid } });
      expect(s.revoked_at).not.toBeNull();
      expect(s.revocation_reason).toBe("lost_device");
    }

    const log = fs.readFileSync(process.env.VS_RECOVERY_LOG_PATH, "utf8");
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe("sessions_revoked_via_recovery_script");
    expect(event.user_id).toBe(user.id);
    expect(event.revoked_sessions).toBe(2);
  });

  it("returns code=2 for unknown user id", async () => {
    const result = await revokeUserSessions(9_999_999, { confirmed: true });
    expect(result).toEqual({ ok: false, code: 2 });
    expect(fs.readFileSync(process.env.VS_RECOVERY_LOG_PATH, "utf8")).toBe("");
  });
});

describe("revoke-user-sessions.js (subprocess)", () => {
  it("prompts for DELETE, executes on match, exits 0", async () => {
    const { user } = await makeMfaUser();
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, "..", "revoke-user-sessions.js"),
        String(user.id),
      ],
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
    child.stdout.on("data", (d) => (stdout += d.toString()));
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(stdout).toMatch(/sessions revoked/i);

    const after = await prisma.users.findUnique({ where: { id: user.id } });
    expect(after.must_rotate_password).toBe(true);
    expect(after.totp_secret_ciphertext).toBe("ciphertext-bytes");
  }, 20_000);
});
