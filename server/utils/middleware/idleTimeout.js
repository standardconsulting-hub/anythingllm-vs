// vs-fork idle-timeout middleware. Plan 1.5 v1.2.1 Task 5.
//
// Designed to run AFTER an auth middleware (validatedRequest or
// requireFullAuth) that has already populated res.locals.session.
// On each authed request:
//   - if last_activity_at > SESSION_IDLE_MS ago → revoke session,
//                                                 401 { session_expired,
//                                                 needs_totp: true }
//   - else                              → touch last_activity_at,
//                                         pass through
//   - if no session in res.locals       → pass through (route is
//                                         public — idle-timeout
//                                         doesn't apply)
//
// The window is enforced server-side; clients cannot extend it.
// Per-session, not per-user — one stale browser tab does not keep
// a different active tab alive.
//
// Operator note: Plan 1.5's default was 15 minutes. Widened to
// 4 hours on 2026-05-12 to match the working pattern at VS — fee-
// earners run the tool across a half-day's drafting session and
// were being kicked out mid-task. The trade-off: an unlocked
// screen gives an opportunistic intruder a 4-hour window rather
// than 15 min. Acceptable in the controlled office; reconsider if
// the deployment ever moves to a less-controlled environment.

const { UserSession } = require("../../models/userSession");

const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;

async function idleTimeout(req, res, next) {
  const session = res.locals?.session;
  if (!session) return next();

  const last = session.last_activity_at
    ? new Date(session.last_activity_at).getTime()
    : null;
  const now = Date.now();

  if (last !== null && now - last > SESSION_IDLE_MS) {
    await UserSession.revoke(session.id, "idle");
    res.status(401).json({
      error: "session_expired",
      needs_totp: true,
    });
    return;
  }

  // Touch — best-effort. If the row was concurrently revoked
  // we'll get { ok: false } and the next request through this
  // middleware will reject via the auth-side session lookup.
  await UserSession.touch(session.id);
  res.locals.session.last_activity_at = new Date(now);
  next();
}

module.exports = { idleTimeout, SESSION_IDLE_MS };
