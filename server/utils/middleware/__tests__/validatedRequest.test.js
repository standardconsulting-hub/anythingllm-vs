// vs-fork validatedRequest tests for Plan 1.5 Task 4 changes.
//
// These exercise the multi-user-mode path. The single-user path
// (legacy AUTH_TOKEN-based) is intentionally untouched and not
// covered here.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

const prisma = require("../../prisma");
const { UserSession } = require("../../../models/userSession");
const {
  issueChallengeToken,
  issueSessionToken,
  CHALLENGE_AUD,
} = require("../../auth/mfaTokens");
const { validatedRequest } = require("../validatedRequest");
const { SystemSettings } = require("../../../models/systemSettings");

async function makeUser(overrides = {}) {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant", ...overrides },
  });
}

function fakeReq({ token = null, path = "/api/system/something", originalUrl } = {}) {
  return {
    header: (n) =>
      n === "Authorization" ? (token ? `Bearer ${token}` : null) : null,
    path,
    originalUrl: originalUrl ?? path,
  };
}

function fakeRes() {
  return {
    locals: {},
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe("validatedRequest (multi-user mode)", () => {
  let testUserIds = [];
  let multiUserSpy;

  beforeAll(() => {
    // Force multi-user mode for this whole suite without touching
    // the actual SystemSettings table.
    multiUserSpy = jest
      .spyOn(SystemSettings, "isMultiUserMode")
      .mockResolvedValue(true);
  });

  afterAll(() => {
    multiUserSpy?.mockRestore?.();
  });

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("rejects request with no Authorization header", async () => {
    const next = jest.fn();
    const res = fakeRes();
    await validatedRequest(fakeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a legacy upstream JWT shape with needs_totp:true", async () => {
    // Build a legacy token without aud=vs-declaration.
    const JWT = require("jsonwebtoken");
    const u = await makeUser();
    testUserIds.push(u.id);
    const legacy = JWT.sign({ id: u.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    const next = jest.fn();
    const res = fakeRes();
    await validatedRequest(fakeReq({ token: legacy }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].needs_totp).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a challenge token (wrong aud) with 401", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { token } = await issueChallengeToken({
      userId: u.id,
      aud: CHALLENGE_AUD,
    });
    const next = jest.fn();
    const res = fakeRes();
    await validatedRequest(fakeReq({ token }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a session JWT whose session row has been revoked", async () => {
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
    await validatedRequest(fakeReq({ token }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe("session_expired");
  });

  it("rejects when totp_verified_at is null with needs_enrolment:true", async () => {
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
    await validatedRequest(fakeReq({ token }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].needs_enrolment).toBe(true);
  });

  it("rejects must_rotate_password=true on a non-rotation path", async () => {
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
    await validatedRequest(
      fakeReq({ token, path: "/api/system/foo", originalUrl: "/api/system/foo" }),
      res,
      next
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toBe("must_rotate_password");
  });

  it("permits must_rotate_password=true on /api/system/update-password", async () => {
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
    await validatedRequest(
      fakeReq({
        token,
        path: "/api/system/update-password",
        originalUrl: "/api/system/update-password",
      }),
      res,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("populates res.locals.user and res.locals.session on success", async () => {
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
    await validatedRequest(fakeReq({ token }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.user.id).toBe(u.id);
    expect(res.locals.session.id).toBe(session.id);
    expect(res.locals.multiUserMode).toBe(true);
  });

  it("rejects when user is suspended", async () => {
    const u = await makeUser({ totp_verified_at: new Date(), suspended: 1 });
    testUserIds.push(u.id);
    const session = await UserSession.create({ userId: u.id });
    const token = issueSessionToken({
      userId: u.id,
      sessionId: session.id,
      expiresAt: session.expires_at,
    });
    const next = jest.fn();
    const res = fakeRes();
    await validatedRequest(fakeReq({ token }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toMatch(/suspended/i);
  });
});
