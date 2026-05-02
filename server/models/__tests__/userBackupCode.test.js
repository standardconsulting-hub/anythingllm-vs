// vs-fork user_backup_codes model tests. Plan 1.5 v1.2.1 Task 2.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);

const prisma = require("../../utils/prisma");
const totp = require("../../utils/totp");
const { UserBackupCode } = require("../userBackupCode");

async function makeUser() {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant" },
  });
}

describe("UserBackupCode model", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("seed() inserts one row per code and returns the count", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const codes = totp.generateBackupCodes();
    const hashes = await totp.hashBackupCodes(codes);
    const n = await UserBackupCode.seed(u.id, hashes);
    expect(n).toBe(10);
    expect(await UserBackupCode.countUnused(u.id)).toBe(10);
  });

  it("consumeIfValid() succeeds once on a valid code, then fails on retry", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const codes = totp.generateBackupCodes();
    const hashes = await totp.hashBackupCodes(codes);
    await UserBackupCode.seed(u.id, hashes);
    const first = await UserBackupCode.consumeIfValid(u.id, codes[0]);
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(9);
    const second = await UserBackupCode.consumeIfValid(u.id, codes[0]);
    expect(second.ok).toBe(false);
  });

  it("consumeIfValid() rejects an unknown code", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const codes = totp.generateBackupCodes();
    const hashes = await totp.hashBackupCodes(codes);
    await UserBackupCode.seed(u.id, hashes);
    const r = await UserBackupCode.consumeIfValid(u.id, "definitely-not-a-code");
    expect(r.ok).toBe(false);
  });

  it("concurrent consume of the same code — exactly one wins", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const codes = totp.generateBackupCodes();
    const hashes = await totp.hashBackupCodes(codes);
    await UserBackupCode.seed(u.id, hashes);
    const [a, b] = await Promise.all([
      UserBackupCode.consumeIfValid(u.id, codes[0]),
      UserBackupCode.consumeIfValid(u.id, codes[0]),
    ]);
    const wins = [a, b].filter((r) => r.ok).length;
    expect(wins).toBe(1);
    expect(await UserBackupCode.countUnused(u.id)).toBe(9);
  });

  it("wipe() removes all codes for the user", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const codes = totp.generateBackupCodes();
    const hashes = await totp.hashBackupCodes(codes);
    await UserBackupCode.seed(u.id, hashes);
    const deleted = await UserBackupCode.wipe(u.id);
    expect(deleted.count).toBe(10);
    expect(await UserBackupCode.countUnused(u.id)).toBe(0);
  });
});
