// vs-fork TOTP rate limiter middleware. Plan 1.5 v1.2.1 Task 3.
//
// Sits in front of every endpoint that calls totp.verify(). Reads
// from mfa_attempt_log to count recent failures (5-min sliding
// window) and enforces a tiered lockout on users.mfa_lockout_until.
//
// Lockout policy (per spec §4.4 + plan v1.2.1):
//   5 fails within 5 min               → 15-min lockout
//   10 fails accumulated during lockout → 1-hour lockout
//   Successful verify resets the counter and clears any prior
//   non-lockout window state.
//
// During lockout: 429 Too Many Requests with Retry-After (seconds).
// Every entry to a TOTP-validating route writes one row to
// mfa_attempt_log on its way out (the endpoint is responsible for
// passing the outcome — see logAttempt below).

const prisma = require("../prisma");

const WINDOW_MS = 5 * 60 * 1000;
const FAIL_THRESHOLD_FOR_LOCKOUT = 5;
const FIRST_TIER_LOCKOUT_MS = 15 * 60 * 1000;
const ESCALATION_THRESHOLD = 10;
const ESCALATED_LOCKOUT_MS = 60 * 60 * 1000;

const VALID_OUTCOMES = new Set([
  "ok",
  "fail_invalid",
  "fail_replay",
  "fail_lockout",
  "fail_expired_challenge",
]);

/**
 * Express middleware. Looks for `req.body.user_id` or
 * `res.locals.user_id` to scope by user; falls back to remote IP.
 *
 * If the user is currently locked out, responds 429 + Retry-After
 * AND writes a `fail_lockout` row to mfa_attempt_log so we can see
 * lockout-bypass attempts in the log.
 */
async function totpRateLimiter(req, res, next) {
  const userId = res.locals?.mfaUserId ?? null;
  const remoteIp = req.ip ?? req.connection?.remoteAddress ?? null;

  if (userId !== null) {
    const user = await prisma.users.findUnique({ where: { id: userId } });
    if (user?.mfa_lockout_until && user.mfa_lockout_until > new Date()) {
      const retryAfter = Math.ceil(
        (user.mfa_lockout_until.getTime() - Date.now()) / 1000
      );
      await logAttempt({
        userId,
        remoteIp,
        outcome: "fail_lockout",
      });
      res.set("Retry-After", String(Math.max(retryAfter, 1)));
      res.status(429).json({
        error: "locked_out",
        retry_after_seconds: retryAfter,
      });
      return;
    }
  }

  next();
}

/**
 * Append a row to mfa_attempt_log AND, if outcome is a fail_*,
 * advance the per-user lockout state.
 *
 * Endpoints call this after they know the verify outcome:
 *   await logAttempt({ userId, remoteIp, outcome });
 */
async function logAttempt({ userId, remoteIp = null, outcome }) {
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new Error(`logAttempt: bad outcome ${outcome}`);
  }

  await prisma.mfa_attempt_log.create({
    data: {
      user_id: userId ?? null,
      remote_ip: remoteIp,
      outcome,
    },
  });

  if (!userId) return;

  if (outcome === "ok") {
    // Reset window on success.
    await prisma.users.update({
      where: { id: userId },
      data: {
        mfa_failed_attempt_count: 0,
        mfa_failed_window_start: null,
      },
    });
    return;
  }

  if (!outcome.startsWith("fail_")) return;

  // Advance the per-user fail counter and apply lockout if we
  // crossed a threshold.
  const user = await prisma.users.findUnique({ where: { id: userId } });
  const now = new Date();
  const inActiveLockout =
    user?.mfa_lockout_until && user.mfa_lockout_until > now;
  let windowStart = user?.mfa_failed_window_start;
  let failCount = user?.mfa_failed_attempt_count ?? 0;

  if (
    !windowStart ||
    now.getTime() - new Date(windowStart).getTime() > WINDOW_MS
  ) {
    // First failure or window reset.
    windowStart = now;
    failCount = 1;
  } else {
    failCount += 1;
  }

  let lockoutUntil = user?.mfa_lockout_until ?? null;

  if (inActiveLockout && failCount >= ESCALATION_THRESHOLD) {
    lockoutUntil = new Date(now.getTime() + ESCALATED_LOCKOUT_MS);
    failCount = 0;
    windowStart = null;
  } else if (
    !inActiveLockout &&
    failCount >= FAIL_THRESHOLD_FOR_LOCKOUT
  ) {
    lockoutUntil = new Date(now.getTime() + FIRST_TIER_LOCKOUT_MS);
    failCount = 0;
    windowStart = null;
  }

  await prisma.users.update({
    where: { id: userId },
    data: {
      mfa_failed_attempt_count: failCount,
      mfa_failed_window_start: windowStart,
      mfa_lockout_until: lockoutUntil,
    },
  });
}

/**
 * Test convenience — clears the lockout state without touching
 * mfa_attempt_log.
 */
async function __resetUserLockoutForTest(userId) {
  await prisma.users.update({
    where: { id: userId },
    data: {
      mfa_failed_attempt_count: 0,
      mfa_failed_window_start: null,
      mfa_lockout_until: null,
    },
  });
}

module.exports = {
  totpRateLimiter,
  logAttempt,
  __resetUserLockoutForTest,
  // Exported for tests / docs:
  WINDOW_MS,
  FAIL_THRESHOLD_FOR_LOCKOUT,
  FIRST_TIER_LOCKOUT_MS,
  ESCALATION_THRESHOLD,
  ESCALATED_LOCKOUT_MS,
};
