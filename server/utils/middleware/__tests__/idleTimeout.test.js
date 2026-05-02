// vs-fork idle-timeout tests. Plan 1.5 v1.2.1 Task 5.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);

const prisma = require("../../prisma");
const { UserSession } = require("../../../models/userSession");
const { idleTimeout, SESSION_IDLE_MS } = require("../idleTimeout");

async function makeUser() {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant" },
  });
}

function fakeRes(session) {
  return {
    locals: { session },
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe("idleTimeout", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("passes through and touches last_activity_at when fresh", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const original = new Date(session.last_activity_at).getTime();
    await new Promise((r) => setTimeout(r, 1100));
    const next = jest.fn();
    const res = fakeRes(session);
    await idleTimeout({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    const refreshed = await UserSession.findActive(session.id);
    expect(new Date(refreshed.last_activity_at).getTime()).toBeGreaterThan(
      original
    );
  });

  it("revokes session and returns 401 session_expired when stale", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    // Force last_activity_at into the past beyond the threshold.
    const longAgo = new Date(Date.now() - SESSION_IDLE_MS - 60_000);
    await prisma.user_sessions.update({
      where: { id: session.id },
      data: { last_activity_at: longAgo },
    });
    const stale = await UserSession.findActive(session.id);
    const next = jest.fn();
    const res = fakeRes(stale);
    await idleTimeout({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe("session_expired");
    expect(res.json.mock.calls[0][0].needs_totp).toBe(true);
    // Row is now revoked.
    const after = await prisma.user_sessions.findUnique({
      where: { id: session.id },
    });
    expect(after.revoked_at).not.toBeNull();
    expect(after.revocation_reason).toBe("idle");
  });

  it("after idle-out the same JWT cannot be revived (revoke is permanent)", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const longAgo = new Date(Date.now() - SESSION_IDLE_MS - 60_000);
    await prisma.user_sessions.update({
      where: { id: session.id },
      data: { last_activity_at: longAgo },
    });
    const stale = await UserSession.findActive(session.id);
    await idleTimeout({}, fakeRes(stale), jest.fn());
    // findActive() should now return null because the row is revoked.
    expect(await UserSession.findActive(session.id)).toBeNull();
  });

  it("passes through when no session is on res.locals (public route)", async () => {
    const next = jest.fn();
    const res = { locals: {}, status: jest.fn(), json: jest.fn() };
    await idleTimeout({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
