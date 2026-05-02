// vs-fork TOTP-aware auth middlewares. Plan 1.5 v1.2.1 Task 3.
//
// Two exports:
//   requireFullAuth          — reject unless caller holds a valid
//                              session JWT, the session row is
//                              active, and the user has completed
//                              MFA enrolment (totp_verified_at set).
//   requireFreshStepUp(N)    — additionally require that the
//                              session row's last_step_up_at is
//                              within N minutes.
//
// On success both populate:
//   res.locals.user          — the users row
//   res.locals.session       — the user_sessions row
//
// On failure both respond with:
//   401 { error: "needs_auth" }                    — unauthenticated
//   401 { error: "session_expired", needs_totp: true }  — session revoked / expired
//   403 { error: "needs_enrolment", needs_enrolment: true }  — MFA not enrolled
//   403 { error: "needs_step_up", needs_totp: true }   — step-up stale
//   403 { error: "must_rotate_password" }          — password rotation pending

const prisma = require("../prisma");
const { UserSession } = require("../../models/userSession");
const { verifySessionToken } = require("../auth/mfaTokens");
const { SESSION_IDLE_MS } = require("./idleTimeout");

function bearerToken(req) {
  const auth = req.header?.("Authorization") ?? req.headers?.authorization;
  if (!auth || typeof auth !== "string") return null;
  const parts = auth.split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

async function requireFullAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "needs_auth" });
  }
  const decoded = verifySessionToken(token);
  if (!decoded.ok) {
    return res.status(401).json({ error: "needs_auth", reason: decoded.reason });
  }

  const session = await UserSession.findActive(decoded.session_id);
  if (!session || session.user_id !== decoded.user_id) {
    return res
      .status(401)
      .json({ error: "session_expired", needs_totp: true });
  }

  const user = await prisma.users.findUnique({ where: { id: decoded.user_id } });
  if (!user) {
    return res.status(401).json({ error: "needs_auth" });
  }
  if (!user.totp_verified_at) {
    return res
      .status(403)
      .json({ error: "needs_enrolment", needs_enrolment: true });
  }
  // Plan 1.5 final-Codex BLOCK 2: only /api/auth/rotate-password
  // can clear must_rotate_password. The earlier suffix check
  // ("/change-password") matched a non-existent endpoint and
  // would have locked out users permanently.
  if (
    user.must_rotate_password === true &&
    !(req.path?.endsWith("/auth/rotate-password") ||
      req.originalUrl?.split("?")[0] === "/api/auth/rotate-password")
  ) {
    return res.status(403).json({ error: "must_rotate_password" });
  }

  // vs-fork: 15-minute per-session idle timeout (Plan 1.5 v1.2.1
  // Task 5). Same enforcement as validatedRequest so MFA-aware
  // routes (the requireFullAuth chain) are equally protected.
  // Final-Codex FLAG fix: take the touch's ok/false as the
  // authoritative liveness signal so a concurrent revoke can't
  // race past the idle check.
  const lastActivityMs = session.last_activity_at
    ? new Date(session.last_activity_at).getTime()
    : null;
  if (lastActivityMs !== null && Date.now() - lastActivityMs > SESSION_IDLE_MS) {
    await UserSession.revoke(session.id, "idle");
    return res
      .status(401)
      .json({ error: "session_expired", needs_totp: true });
  }
  const touch = await UserSession.touch(session.id);
  if (!touch.ok) {
    return res
      .status(401)
      .json({ error: "session_expired", needs_totp: true });
  }

  res.locals.user = user;
  res.locals.session = session;
  next();
}

function requireFreshStepUp(maxMinutes = 5) {
  const maxMs = maxMinutes * 60 * 1000;
  return async function (req, res, next) {
    const session = res.locals?.session;
    if (!session) {
      return res
        .status(500)
        .json({ error: "requireFreshStepUp called without requireFullAuth" });
    }
    const last = session.last_step_up_at;
    if (!last || Date.now() - new Date(last).getTime() > maxMs) {
      return res
        .status(403)
        .json({ error: "needs_step_up", needs_totp: true });
    }
    next();
  };
}

module.exports = { requireFullAuth, requireFreshStepUp };
