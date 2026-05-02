// vs-fork user_backup_codes model. Plan 1.5 v1.2.1 Task 2.

const prisma = require("../utils/prisma");
const bcrypt = require("bcrypt");

const UserBackupCode = {
  /**
   * Insert one row per (already-hashed) backup code for a user.
   * Returns the count inserted.
   *
   * Prisma SQLite < 5.12 does not implement createMany, so we
   * issue an array of create() calls inside a $transaction for
   * atomicity (all-or-nothing if any insert fails).
   */
  async seed(userId, hashedCodes) {
    const ops = hashedCodes.map((code_hash) =>
      prisma.user_backup_codes.create({
        data: { user_id: userId, code_hash },
      })
    );
    const rows = await prisma.$transaction(ops);
    return rows.length;
  },

  /**
   * Walk the user's unused codes. For each, run bcrypt.compare. On
   * the first match, issue a single UPDATE WHERE id = ? AND used_at
   * IS NULL and assert rowcount === 1. The atomicity prevents two
   * concurrent callers from both consuming the same code.
   *
   * Returns { ok: true, remaining } | { ok: false }.
   */
  async consumeIfValid(userId, plainCode) {
    const candidates = await prisma.user_backup_codes.findMany({
      where: { user_id: userId, used_at: null },
      orderBy: { id: "asc" },
    });
    for (const row of candidates) {
      const match = await bcrypt.compare(plainCode, row.code_hash);
      if (!match) continue;
      const now = new Date();
      const result = await prisma.$executeRaw`
        UPDATE user_backup_codes
           SET used_at = ${now}
         WHERE id = ${row.id}
           AND used_at IS NULL
      `;
      if (result === 1) {
        const remaining = await prisma.user_backup_codes.count({
          where: { user_id: userId, used_at: null },
        });
        return { ok: true, remaining };
      }
      // Lost the race — fall through to keep scanning (extremely
      // unlikely a different code also matches, but for safety).
    }
    return { ok: false };
  },

  async countUnused(userId) {
    return prisma.user_backup_codes.count({
      where: { user_id: userId, used_at: null },
    });
  },

  async wipe(userId) {
    return prisma.user_backup_codes.deleteMany({
      where: { user_id: userId },
    });
  },

  // Test convenience.
  async __wipeAll() {
    return prisma.user_backup_codes.deleteMany({});
  },
};

module.exports = { UserBackupCode };
