// vs-fork requireTotp tests. Plan 1.5 v1.2.1 Task 3.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

const prisma = require("../../prisma");
const { UserSession } = require("../../../models/userSession");
const { issueSessionToken } = require("../../auth/mfaTokens");
const { requireFullAuth, requireFreshStepUp } = require("../requireTotp");

async function makeUser(overrides = {}) {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: {
      username,
      password: "irrelevant",
      ...overrides,
    },
  });
}

function fakeReq(token, path = "/api/test") {
  return {
    header: (name) => (name === "Authorization" ? `Bearer ${token}` : null),
    path,
  };
}

function fakeRes() {
  const res = {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

describe("requireFullAuth", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("rejects request with no Authorization header", async () => {
    const next = jest.fn();
    const res = fakeRes();
    await requireFullAuth({ header: () => null, path: "/" }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects garbage bearer token", async () => {
    const next = jest.fn();
    const res = fakeRes();
    await requireFullAuth(fakeReq("not-a-jwt"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects when session row is revoked", async () => {
    const u = await makeUser({ totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    await UserSession.revoke(session.id, "logout");
    const token = issueSessionToken({
      userId: u.id,
      sessionId: session.id,
      expiresAt: session.expires_at,
    });
    const next = jest.fn();
    const res = fakeRes();
    await requireFullAuth(fakeReq(token), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe("session_expired");
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects when MFA enrolment is incomplete", async () => {
    const u = await makeUser({ totp_verified_at: null });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const token = issueSessionToken({
      userId: u.id,
      sessionId: session.id,
      expiresAt: session.expires_at,
    });
    const next = jest.fn();
    const res = fakeRes();
    await requireFullAuth(fakeReq(token), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].needs_enrolment).toBe(true);
  });

  it("rejects when must_rotate_password is true and path is not change-password", async () => {
    const u = await makeUser({
      totp_verified_at: new Date(),
      must_rotate_password: true,
    });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const token = issueSessionToken({
      userId: u.id,
      sessionId: session.id,
      expiresAt: session.expires_at,
    });
    const next = jest.fn();
    const res = fakeRes();
    await requireFullAuth(fakeReq(token, "/api/system/foo"), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toBe("must_rotate_password");
  });

  it("passes through and populates res.locals when fully authed and enrolled", async () => {
    const u = await makeUser({ totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const token = issueSessionToken({
      userId: u.id,
      sessionId: session.id,
      expiresAt: session.expires_at,
    });
    const next = jest.fn();
    const res = fakeRes();
    await requireFullAuth(fakeReq(token), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.user.id).toBe(u.id);
    expect(res.locals.session.id).toBe(session.id);
  });
});

describe("requireFreshStepUp(5)", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("rejects when last_step_up_at is null", async () => {
    const u = await makeUser({ totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const next = jest.fn();
    const res = { locals: { user: u, session }, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await requireFreshStepUp(5)({}, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].needs_totp).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes when last_step_up_at is recent", async () => {
    const u = await makeUser({ totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    await UserSession.markStepUp(session.id);
    const fresh = await UserSession.findActive(session.id);
    const next = jest.fn();
    const res = { locals: { user: u, session: fresh }, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await requireFreshStepUp(5)({}, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects when last_step_up_at is older than maxMinutes", async () => {
    const u = await makeUser({ totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.user_sessions.update({
      where: { id: session.id },
      data: { last_step_up_at: old },
    });
    const stale = await UserSession.findActive(session.id);
    const next = jest.fn();
    const res = { locals: { user: u, session: stale }, status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await requireFreshStepUp(5)({}, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
