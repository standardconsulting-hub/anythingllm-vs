// vs-fork mfaTokens helper tests. Plan 1.5 v1.2.1 Task 3.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

const prisma = require("../../prisma");
const {
  issueChallengeToken,
  consumeChallengeToken,
  issueSessionToken,
  verifySessionToken,
  CHALLENGE_AUD,
  ENROLMENT_AUD,
  SESSION_AUD,
} = require("../mfaTokens");

async function makeUser() {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant" },
  });
}

describe("mfaTokens — challenge tokens", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("issueChallengeToken creates a JWT + a nonce row that consume can match", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { token, jti } = await issueChallengeToken({
      userId: u.id,
      aud: CHALLENGE_AUD,
    });
    expect(token.split(".")).toHaveLength(3);
    const result = await consumeChallengeToken(token, CHALLENGE_AUD);
    expect(result.ok).toBe(true);
    expect(result.user_id).toBe(u.id);
    // The nonce row should now be marked consumed.
    const row = await prisma.mfa_challenge_nonces.findUnique({ where: { jti } });
    expect(row.consumed_at).not.toBeNull();
  });

  it("consumeChallengeToken rejects reuse with reason=already_consumed", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { token } = await issueChallengeToken({
      userId: u.id,
      aud: CHALLENGE_AUD,
    });
    await consumeChallengeToken(token, CHALLENGE_AUD);
    const second = await consumeChallengeToken(token, CHALLENGE_AUD);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_consumed");
  });

  it("consumeChallengeToken rejects wrong-aud", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { token } = await issueChallengeToken({
      userId: u.id,
      aud: ENROLMENT_AUD,
    });
    const r = await consumeChallengeToken(token, CHALLENGE_AUD);
    expect(r.ok).toBe(false);
    // jsonwebtoken throws JsonWebTokenError "jwt audience invalid"
    // before we ever touch the nonce row → reason = bad_token.
    expect(["bad_token", "wrong_aud"]).toContain(r.reason);
  });

  it("consumeChallengeToken rejects garbage tokens", async () => {
    const r = await consumeChallengeToken("not-a-jwt", CHALLENGE_AUD);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad_token");
  });

  it("issueChallengeToken rejects bad aud", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    await expect(
      issueChallengeToken({ userId: u.id, aud: "not-a-real-aud" })
    ).rejects.toThrow(/bad aud/);
  });
});

describe("mfaTokens — session tokens", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("issueSessionToken + verifySessionToken round-trip", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const sessionId = "01H6Z000000000000000000001";
    const expiresAt = new Date(Date.now() + 60_000);
    const token = issueSessionToken({
      userId: u.id,
      sessionId,
      expiresAt,
    });
    const r = verifySessionToken(token);
    expect(r.ok).toBe(true);
    expect(r.user_id).toBe(u.id);
    expect(r.session_id).toBe(sessionId);
  });

  it("verifySessionToken rejects a challenge token (wrong aud)", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { token } = await issueChallengeToken({
      userId: u.id,
      aud: CHALLENGE_AUD,
    });
    const r = verifySessionToken(token);
    expect(r.ok).toBe(false);
    expect(["bad_token", "wrong_aud"]).toContain(r.reason);
  });

  it("verifySessionToken rejects garbage", () => {
    expect(verifySessionToken(null).ok).toBe(false);
    expect(verifySessionToken("not.a.jwt").ok).toBe(false);
  });
});
