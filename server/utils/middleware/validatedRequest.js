const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { EncryptionManager } = require("../EncryptionManager");
const { decodeJWT } = require("../http");
// vs-fork: Plan 1.5 v1.2.1 Task 4 — validate session JWTs against
// the user_sessions row + reject challenge tokens reaching
// protected routes. Task 5 — also enforces 15-min idle timeout
// in the same pass (revokes the session row + 401 session_expired
// on idle-out).
const { verifySessionToken } = require("../auth/mfaTokens");
const { UserSession } = require("../../models/userSession");
const { SESSION_IDLE_MS } = require("./idleTimeout");
const EncryptionMgr = new EncryptionManager();

// Endpoints that a user with must_rotate_password=true can still
// reach. Add to this list when introducing new password-rotation
// surfaces. (Plan 1.5 v1.2.1 Task 4.)
const ROTATE_PASSWORD_ALLOWED_PATHS = new Set([
  "/api/system/update-password",
  "/api/system/user",
]);

async function validatedRequest(request, response, next) {
  const multiUserMode = await SystemSettings.isMultiUserMode();
  response.locals.multiUserMode = multiUserMode;
  if (multiUserMode)
    return await validateMultiUserRequest(request, response, next);

  // When in development passthrough auth token for ease of development.
  // Or if the user simply did not set an Auth token or JWT Secret
  if (
    process.env.NODE_ENV === "development" ||
    !process.env.AUTH_TOKEN ||
    !process.env.JWT_SECRET
  ) {
    next();
    return;
  }

  if (!process.env.AUTH_TOKEN) {
    response.status(401).json({
      error: "You need to set an AUTH_TOKEN environment variable.",
    });
    return;
  }

  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  const bcrypt = require("bcryptjs");
  const { p } = decodeJWT(token);

  if (p === null || !/\w{32}:\w{32}/.test(p)) {
    response.status(401).json({
      error: "Token expired or failed validation.",
    });
    return;
  }

  // Since the blame of this comment we have been encrypting the `p` property of JWTs with the persistent
  // encryptionManager PEM's. This prevents us from storing the `p` unencrypted in the JWT itself, which could
  // be unsafe. As a consequence, existing JWTs with invalid `p` values that do not match the regex
  // in ln:44 will be marked invalid so they can be logged out and forced to log back in and obtain an encrypted token.
  // This kind of methodology only applies to single-user password mode.
  if (
    !bcrypt.compareSync(
      EncryptionMgr.decrypt(p),
      bcrypt.hashSync(process.env.AUTH_TOKEN, 10)
    )
  ) {
    response.status(401).json({
      error: "Invalid auth credentials.",
    });
    return;
  }

  next();
}

async function validateMultiUserRequest(request, response, next) {
  const auth = request.header("Authorization");
  const token = auth ? auth.split(" ")[1] : null;

  if (!token) {
    response.status(401).json({
      error: "No auth token found.",
    });
    return;
  }

  // vs-fork: Plan 1.5 v1.2.1 Task 4. The token must be a Plan 1.5
  // session JWT (aud="vs-declaration", jti=user_sessions.id).
  // Challenge / enrolment tokens carry a different aud and are
  // rejected before they can reach any protected route.
  const decoded = verifySessionToken(token);
  if (!decoded.ok) {
    // Fall back to the legacy upstream JWT shape only as a hint
    // to log clients out gracefully. Reject in both cases.
    const legacy = decodeJWT(token);
    if (legacy && legacy.id) {
      response.status(401).json({
        error: "Legacy auth token rejected. Re-login to obtain an MFA-bound session.",
        needs_totp: true,
      });
      return;
    }
    response.status(401).json({
      error: "Invalid auth token.",
      reason: decoded.reason,
    });
    return;
  }

  const session = await UserSession.findActive(decoded.session_id);
  if (!session || session.user_id !== decoded.user_id) {
    response.status(401).json({
      error: "session_expired",
      needs_totp: true,
    });
    return;
  }

  const user = await User.get({ id: decoded.user_id });
  if (!user) {
    response.status(401).json({
      error: "Invalid auth for user.",
    });
    return;
  }

  if (user.suspended) {
    response.status(401).json({
      error: "User is suspended from system",
    });
    return;
  }

  // MFA enrolment must be complete before reaching any protected
  // route. Plan 1.5 Task 4.
  if (!user.totp_verified_at) {
    response.status(403).json({
      error: "needs_enrolment",
      needs_enrolment: true,
    });
    return;
  }

  // must_rotate_password gates everything except the rotate
  // endpoints themselves. Plan 1.5 Task 4 (FLAG closure for the
  // recovery-script-forces-rotation requirement).
  if (
    user.must_rotate_password === true &&
    !ROTATE_PASSWORD_ALLOWED_PATHS.has(
      request.originalUrl?.split("?")[0] || request.path
    )
  ) {
    response.status(403).json({
      error: "must_rotate_password",
    });
    return;
  }

  response.locals.user = user;
  response.locals.session = session;

  // vs-fork: enforce 15-minute per-session idle timeout in the
  // same auth pass. Plan 1.5 v1.2.1 Task 5.
  const lastActivityMs = session.last_activity_at
    ? new Date(session.last_activity_at).getTime()
    : null;
  if (lastActivityMs !== null && Date.now() - lastActivityMs > SESSION_IDLE_MS) {
    await UserSession.revoke(session.id, "idle");
    response.status(401).json({
      error: "session_expired",
      needs_totp: true,
    });
    return;
  }
  await UserSession.touch(session.id);
  next();
}

module.exports = {
  validatedRequest,
};
