// vs-fork user_sessions model tests. Plan 1.5 v1.2.1 Task 2.
//
// These tests hit the real Prisma SQLite at server/storage/. Each
// test creates an isolated test user with a unique username, then
// cleans up via the cascading users delete.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);

const prisma = require("../../utils/prisma");
const { UserSession } = require("../userSession");

async function makeUser() {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant-for-this-test" },
  });
}

describe("UserSession model", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("create() inserts a row with a ULID id and last_activity_at = ~now", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const before = Date.now();
    const session = await UserSession.create({ userId: u.id });
    const after = Date.now();
    expect(session.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID Crockford base32
    expect(session.user_id).toBe(u.id);
    expect(session.last_activity_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(session.last_activity_at.getTime()).toBeLessThanOrEqual(after);
    expect(session.revoked_at).toBeNull();
    expect(session.last_step_up_at).toBeNull();
  });

  it("touch() updates last_activity_at on an active session", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s = await UserSession.create({ userId: u.id });
    const original = s.last_activity_at.getTime();
    await new Promise((r) => setTimeout(r, 1100)); // SQLite DateTime precision
    const r = await UserSession.touch(s.id);
    expect(r.ok).toBe(true);
    expect(r.row.last_activity_at.getTime()).toBeGreaterThan(original);
  });

  it("touch() refuses to touch a revoked session", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s = await UserSession.create({ userId: u.id });
    await UserSession.revoke(s.id, "logout");
    const r = await UserSession.touch(s.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_or_revoked");
  });

  it("revoke() returns true once and false on subsequent calls", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s = await UserSession.create({ userId: u.id });
    const a = await UserSession.revoke(s.id, "logout");
    const b = await UserSession.revoke(s.id, "logout");
    expect(a).toBe(true);
    expect(b).toBe(false);
  });

  it("revokeAllForUser() revokes only active rows and returns the count", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s1 = await UserSession.create({ userId: u.id });
    const s2 = await UserSession.create({ userId: u.id });
    await UserSession.revoke(s1.id, "logout"); // pre-revoked, should not be re-counted
    const count = await UserSession.revokeAllForUser(u.id, "lost_device");
    expect(count).toBe(1); // only s2
    expect(await UserSession.findActive(s2.id)).toBeNull();
  });

  it("findActive() returns null for revoked or expired sessions", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s = await UserSession.create({ userId: u.id });
    expect(await UserSession.findActive(s.id)).toBeTruthy();
    await UserSession.revoke(s.id, "logout");
    expect(await UserSession.findActive(s.id)).toBeNull();
  });

  it("markStepUp() sets last_step_up_at on the row", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s = await UserSession.create({ userId: u.id });
    expect(s.last_step_up_at).toBeNull();
    await UserSession.markStepUp(s.id);
    const after = await UserSession.findActive(s.id);
    expect(after.last_step_up_at).not.toBeNull();
  });

  it("revoke() under concurrent calls — only one wins", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const s = await UserSession.create({ userId: u.id });
    const [a, b] = await Promise.all([
      UserSession.revoke(s.id, "logout"),
      UserSession.revoke(s.id, "logout"),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });
});
