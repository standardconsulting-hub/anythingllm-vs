// vs-fork mfa_challenge_nonces model. Plan 1.5 v1.2.1 Task 2.
//
// One row per challenge JWT jti. The atomic consume operation is
// a single UPDATE — see the inline SQL — which makes single-use
// enforcement structural rather than a check-then-act race.
//
// Endpoints derive user_id from the JWT `sub` claim after
// signature + audience validation; consume() returns only { ok }
// and a reason on failure (defence-in-depth: identity is bound
// by the JWT signature, not by the nonce row).

const prisma = require("../utils/prisma");
const { ulid } = require("ulid");

const MfaChallengeNonce = {
  /**
   * Create a new nonce row. Returns { jti, expires_at }.
   */
  async create({
    userId,
    aud,
    ttlSeconds,
    remoteIp = null,
    userAgent = null,
  }) {
    if (!aud || (aud !== "mfa-challenge" && aud !== "mfa-enrolment")) {
      throw new Error(`MfaChallengeNonce.create: bad aud ${aud}`);
    }
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`MfaChallengeNonce.create: ttlSeconds must be > 0`);
    }
    const jti = ulid();
    const now = new Date();
    const expires_at = new Date(now.getTime() + ttlSeconds * 1000);
    await prisma.mfa_challenge_nonces.create({
      data: {
        jti,
        user_id: userId,
        aud,
        expires_at,
        consumed_at: null,
        created_at: now,
        remote_ip: remoteIp,
        user_agent: userAgent,
      },
    });
    return { jti, expires_at };
  },

  /**
   * Atomic single-use consume. Returns:
   *   { ok: true }
   *   { ok: false, reason: "unknown" | "wrong_aud" | "expired"
   *                       | "already_consumed" }
   *
   * Identity (user_id) is NOT returned by design — the calling
   * endpoint must use the JWT `sub` claim already validated by
   * signature + audience. This prevents the nonce row from being
   * the sole authority over identity.
   */
  async consume(jti, expectedAud) {
    const now = new Date();
    const result = await prisma.$executeRaw`
      UPDATE mfa_challenge_nonces
         SET consumed_at = ${now}
       WHERE jti = ${jti}
         AND aud = ${expectedAud}
         AND consumed_at IS NULL
         AND expires_at > ${now}
    `;
    if (result === 1) return { ok: true };

    // Diagnose why we missed for the caller's logs.
    const row = await prisma.mfa_challenge_nonces.findUnique({
      where: { jti },
    });
    if (!row) return { ok: false, reason: "unknown" };
    if (row.aud !== expectedAud) return { ok: false, reason: "wrong_aud" };
    if (row.consumed_at !== null) {
      return { ok: false, reason: "already_consumed" };
    }
    if (row.expires_at <= now) return { ok: false, reason: "expired" };
    // Concurrent race: another caller won between our UPDATE and
    // our diagnostic SELECT. Treat as already_consumed.
    return { ok: false, reason: "already_consumed" };
  },

  /**
   * Periodic cleanup. Out of plan scope; called from a cron in
   * Plan 5 governance pack.
   */
  async purgeExpired() {
    const now = new Date();
    return prisma.$executeRaw`
      DELETE FROM mfa_challenge_nonces WHERE expires_at < ${now}
    `;
  },

  // Test convenience.
  async __wipeAll() {
    return prisma.mfa_challenge_nonces.deleteMany({});
  },
};

module.exports = { MfaChallengeNonce };
