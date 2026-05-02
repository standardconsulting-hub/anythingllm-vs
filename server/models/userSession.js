// vs-fork user_sessions model. Plan 1.5 v1.2.1 Task 2.

const prisma = require("../utils/prisma");
const { ulid } = require("ulid");

// Hard ceiling on session lifetime regardless of activity. Even
// a continuously-active session is force-renewed every 30 days.
const SESSION_MAX_LIFETIME_DAYS = 30;

const UserSession = {
  /**
   * Create a new session row keyed on a fresh ULID.
   * Returns the row.
   */
  async create({ userId, userAgent = null, remoteIp = null }) {
    const id = ulid();
    const now = new Date();
    const expires = new Date(
      now.getTime() + SESSION_MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000
    );
    return prisma.user_sessions.create({
      data: {
        id,
        user_id: userId,
        last_activity_at: now,
        last_step_up_at: null,
        revoked_at: null,
        revocation_reason: null,
        user_agent: userAgent,
        remote_ip: remoteIp,
        created_at: now,
        expires_at: expires,
      },
    });
  },

  /**
   * Update last_activity_at on an active session row. Returns
   * { ok: true, row } if the touch succeeded (row was active),
   * { ok: false, reason } otherwise.
   */
  async touch(id) {
    const now = new Date();
    const result = await prisma.$executeRaw`
      UPDATE user_sessions
         SET last_activity_at = ${now}
       WHERE id = ${id}
         AND revoked_at IS NULL
         AND expires_at > ${now}
    `;
    if (result === 1) {
      const row = await prisma.user_sessions.findUnique({ where: { id } });
      return { ok: true, row };
    }
    return { ok: false, reason: "missing_or_revoked" };
  },

  /**
   * Atomic revoke. Only succeeds once for any given session id.
   * Returns true iff this caller actually marked it revoked.
   */
  async revoke(id, reason) {
    const now = new Date();
    const result = await prisma.$executeRaw`
      UPDATE user_sessions
         SET revoked_at = ${now},
             revocation_reason = ${reason}
       WHERE id = ${id}
         AND revoked_at IS NULL
    `;
    return result === 1;
  },

  /**
   * Revoke every active session for a user. Returns the count
   * revoked. Used by lost-device flows.
   */
  async revokeAllForUser(userId, reason) {
    const now = new Date();
    return prisma.$executeRaw`
      UPDATE user_sessions
         SET revoked_at = ${now},
             revocation_reason = ${reason}
       WHERE user_id = ${userId}
         AND revoked_at IS NULL
    `;
  },

  /**
   * Returns the row if active (not revoked, not expired), else null.
   */
  async findActive(id) {
    const row = await prisma.user_sessions.findUnique({ where: { id } });
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at <= new Date()) return null;
    return row;
  },

  /**
   * Set last_step_up_at on a session row. Used by /api/auth/mfa/step-up
   * after a successful TOTP verification.
   */
  async markStepUp(id) {
    const now = new Date();
    await prisma.user_sessions.update({
      where: { id },
      data: { last_step_up_at: now },
    });
  },

  // Test convenience: drop everything. Not exported in production
  // paths.
  async __wipeAll() {
    return prisma.user_sessions.deleteMany({});
  },
};

module.exports = { UserSession };
