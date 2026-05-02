// vs-fork mfa_challenge_nonces model tests. Plan 1.5 v1.2.1 Task 2.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);

const prisma = require("../../utils/prisma");
const { MfaChallengeNonce } = require("../mfaChallengeNonce");

async function makeUser() {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant" },
  });
}

describe("MfaChallengeNonce model", () => {
  let testUserIds = [];

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("create() inserts a row with a fresh ULID jti and expires_at = now + ttl", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const before = Date.now();
    const { jti, expires_at } = await MfaChallengeNonce.create({
      userId: u.id,
      aud: "mfa-challenge",
      ttlSeconds: 300,
    });
    expect(jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(expires_at.getTime()).toBeGreaterThan(before + 250 * 1000);
    expect(expires_at.getTime()).toBeLessThan(before + 350 * 1000);
  });

  it("create() rejects bad aud", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    await expect(
      MfaChallengeNonce.create({ userId: u.id, aud: "wrong", ttlSeconds: 60 })
    ).rejects.toThrow(/bad aud/);
  });

  it("consume() succeeds once with the right aud", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { jti } = await MfaChallengeNonce.create({
      userId: u.id,
      aud: "mfa-challenge",
      ttlSeconds: 60,
    });
    const r = await MfaChallengeNonce.consume(jti, "mfa-challenge");
    expect(r.ok).toBe(true);
  });

  it("consume() rejects reuse with reason=already_consumed", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { jti } = await MfaChallengeNonce.create({
      userId: u.id,
      aud: "mfa-challenge",
      ttlSeconds: 60,
    });
    await MfaChallengeNonce.consume(jti, "mfa-challenge");
    const r = await MfaChallengeNonce.consume(jti, "mfa-challenge");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("already_consumed");
  });

  it("consume() rejects expired with reason=expired", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { jti } = await MfaChallengeNonce.create({
      userId: u.id,
      aud: "mfa-challenge",
      ttlSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));
    const r = await MfaChallengeNonce.consume(jti, "mfa-challenge");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("expired");
  });

  it("consume() rejects wrong aud with reason=wrong_aud", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { jti } = await MfaChallengeNonce.create({
      userId: u.id,
      aud: "mfa-challenge",
      ttlSeconds: 60,
    });
    const r = await MfaChallengeNonce.consume(jti, "mfa-enrolment");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_aud");
  });

  it("consume() rejects unknown jti with reason=unknown", async () => {
    const r = await MfaChallengeNonce.consume(
      "01H6Z000000000000000000000",
      "mfa-challenge"
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown");
  });

  it("concurrent consume — exactly one wins", async () => {
    const u = await makeUser();
    testUserIds.push(u.id);
    const { jti } = await MfaChallengeNonce.create({
      userId: u.id,
      aud: "mfa-challenge",
      ttlSeconds: 60,
    });
    const [a, b] = await Promise.all([
      MfaChallengeNonce.consume(jti, "mfa-challenge"),
      MfaChallengeNonce.consume(jti, "mfa-challenge"),
    ]);
    const wins = [a, b].filter((r) => r.ok).length;
    expect(wins).toBe(1);
  });
});
