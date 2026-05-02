// vs-fork TOTP rate limiter tests. Plan 1.5 v1.2.1 Task 3.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);

const prisma = require("../../prisma");
const {
  totpRateLimiter,
  logAttempt,
  __resetUserLockoutForTest,
  FAIL_THRESHOLD_FOR_LOCKOUT,
  ESCALATION_THRESHOLD,
} = require("../totpRateLimiter");

async function makeUser() {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant" },
  });
}

function fakeReqRes(userId, sentRetryAfter) {
  const req = { ip: "127.0.0.1", connection: {} };
  const res = {
    locals: { mfaUserId: userId },
    set: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  if (sentRetryAfter !== undefined) {
    res.set.mockImplementation((h, v) => {
      sentRetryAfter.value = v;
    });
  }
  return { req, res };
}

describe("totpRateLimiter", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.mfa_attempt_log.deleteMany({
        where: { user_id: { in: testUserIds } },
      });
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("logAttempt(ok) resets the failed-window state", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    await logAttempt({ userId: u.id, outcome: "fail_invalid" });
    await logAttempt({ userId: u.id, outcome: "ok" });
    const after = await prisma.users.findUnique({ where: { id: u.id } });
    expect(after.mfa_failed_attempt_count).toBe(0);
    expect(after.mfa_failed_window_start).toBeNull();
    expect(after.mfa_lockout_until).toBeNull();
  });

  it("crosses lockout threshold after 5 failures and sets mfa_lockout_until", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    for (let i = 0; i < FAIL_THRESHOLD_FOR_LOCKOUT; i++) {
      await logAttempt({ userId: u.id, outcome: "fail_invalid" });
    }
    const after = await prisma.users.findUnique({ where: { id: u.id } });
    expect(after.mfa_lockout_until).not.toBeNull();
    expect(after.mfa_lockout_until.getTime()).toBeGreaterThan(Date.now());
    // Counter resets on lockout.
    expect(after.mfa_failed_attempt_count).toBe(0);
  });

  it("middleware returns 429 + Retry-After during active lockout, and writes fail_lockout", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    for (let i = 0; i < FAIL_THRESHOLD_FOR_LOCKOUT; i++) {
      await logAttempt({ userId: u.id, outcome: "fail_invalid" });
    }
    const sent = {};
    const { req, res } = fakeReqRes(u.id, sent);
    const next = jest.fn();
    await totpRateLimiter(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("locked_out");
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(sent.value).toBeDefined();
    // mfa_attempt_log got a fail_lockout row.
    const last = await prisma.mfa_attempt_log.findFirst({
      where: { user_id: u.id },
      orderBy: { created_at: "desc" },
    });
    expect(last.outcome).toBe("fail_lockout");
  });

  it("after lockout expiry, middleware passes through again", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    // Force a past-expiry lockout.
    await prisma.users.update({
      where: { id: u.id },
      data: {
        mfa_lockout_until: new Date(Date.now() - 1000),
      },
    });
    const next = jest.fn();
    const { req, res } = fakeReqRes(u.id);
    await totpRateLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("escalates to a longer lockout when more failures accumulate during a lockout", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    // Manually set an active lockout.
    await prisma.users.update({
      where: { id: u.id },
      data: {
        mfa_lockout_until: new Date(Date.now() + 60 * 1000),
        mfa_failed_attempt_count: 0,
        mfa_failed_window_start: new Date(),
      },
    });
    // Trigger ESCALATION_THRESHOLD failures (each calls logAttempt).
    for (let i = 0; i < ESCALATION_THRESHOLD; i++) {
      await logAttempt({ userId: u.id, outcome: "fail_invalid" });
    }
    const after = await prisma.users.findUnique({ where: { id: u.id } });
    // The escalated lockout should be MUCH later than the original.
    expect(after.mfa_lockout_until.getTime() - Date.now()).toBeGreaterThan(
      30 * 60 * 1000
    );
  });

  it("ignores attempts with no userId (anonymous path) without crashing", async () => {
    await expect(
      logAttempt({ userId: null, outcome: "fail_invalid" })
    ).resolves.not.toThrow();
  });
});
