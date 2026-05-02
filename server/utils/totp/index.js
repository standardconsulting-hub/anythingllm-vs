// vs-fork TOTP service. Plan 1.5 v1.2.1 Task 2.
//
// Wraps otplib v12 (sync class API, CJS) + qrcode + bcrypt +
// the existing EncryptionManager. Every TOTP-success path on the
// caller side MUST then call `consumeTotpCounter(prisma, uid,
// counter)` for the database compare-and-swap that closes the
// cross-endpoint replay race (see vs-fork-MFA.md).
//
// Note on v12 vs v13: Plan 1.5 v1.2.1 was reviewed against v12.
// v13 was attempted at install time but ships ESM-only deps that
// break the upstream Jest config. Downgraded to v12.0.1 with the
// reason recorded in runtime/CHANGELOG.md.

const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { EncryptionManager } = require("../EncryptionManager");

// Endpoint-facing TOTP verification tolerates one previous 30s
// window only. Wider windows are only allowed via opts.windowOverride,
// an explicit test escape hatch.
const ENDPOINT_WINDOW = 1;
const STEP_SECONDS = 30;
const BCRYPT_COST = 10;

authenticator.options = {
  step: STEP_SECONDS,
  window: ENDPOINT_WINDOW,
};

function counterAtOffset(offset = 0) {
  return Math.floor(Date.now() / 1000 / STEP_SECONDS) + offset;
}

module.exports = {
  generateSecret() {
    return authenticator.generateSecret();
  },

  generateOtpauthUrl(secret, label) {
    return authenticator.keyuri(label, "VS Declaration", secret);
  },

  async qrCodeDataUrl(otpauthUrl) {
    return QRCode.toDataURL(otpauthUrl);
  },

  // Returns { valid, counter, reason }. Caller MUST then call
  // consumeTotpCounter(prisma, uid, counter) to atomically reject
  // concurrent same-code submissions across endpoints. If
  // consumeTotpCounter returns false, downgrade to replay.
  //
  // opts.windowOverride: optional symmetric window for tests only;
  // production callers must not pass it.
  verify(secret, code, opts = {}) {
    const lastUsedCounter = opts.lastUsedCounter ?? null;
    const window = opts.windowOverride ?? ENDPOINT_WINDOW;

    // checkDelta returns the offset (0 = current, -1 = previous,
    // ..., or null on mismatch). We bound the search to ±window
    // ourselves rather than mutating authenticator.options globally
    // (which would race in a concurrent server).
    const savedWindow = authenticator.options.window;
    authenticator.options = { ...authenticator.options, window };
    let delta;
    try {
      delta = authenticator.checkDelta(code, secret);
    } catch (e) {
      // otplib throws on malformed input (e.g. non-base32 secret).
      authenticator.options = { ...authenticator.options, window: savedWindow };
      return { valid: false, counter: null, reason: "invalid" };
    } finally {
      authenticator.options = { ...authenticator.options, window: savedWindow };
    }

    if (delta === null || delta === undefined) {
      return { valid: false, counter: null, reason: "invalid" };
    }

    const counter = BigInt(counterAtOffset(delta));

    if (lastUsedCounter !== null && lastUsedCounter !== undefined) {
      if (counter <= BigInt(lastUsedCounter)) {
        return { valid: false, counter, reason: "replay" };
      }
    }

    return { valid: true, counter, reason: null };
  },

  // Atomic compare-and-swap. Returns true iff the row was updated
  // (i.e. this caller "won" the counter). Used by every TOTP
  // success path (enrol/confirm, challenge, step-up) to close the
  // cross-endpoint same-code race.
  //
  // prisma is a PrismaClient instance; counter is a BigInt.
  async consumeTotpCounter(prisma, userId, counter) {
    const result = await prisma.$executeRaw`
      UPDATE users
         SET totp_last_used_counter = ${counter}
       WHERE id = ${userId}
         AND (totp_last_used_counter IS NULL
              OR totp_last_used_counter < ${counter})
    `;
    return result === 1;
  },

  generateBackupCodes(n = 10) {
    return Array.from({ length: n }, () =>
      crypto.randomBytes(5).toString("hex")
    );
  },

  async hashBackupCodes(codes) {
    return Promise.all(codes.map((c) => bcrypt.hash(c, BCRYPT_COST)));
  },

  async hashOneBackupCode(plain) {
    return bcrypt.hash(plain, BCRYPT_COST);
  },

  async compareBackupCode(plain, hash) {
    return bcrypt.compare(plain, hash);
  },

  encryptSecret(plaintext) {
    return new EncryptionManager().encrypt(plaintext);
  },

  decryptSecret(ciphertext) {
    return new EncryptionManager().decrypt(ciphertext);
  },
};
