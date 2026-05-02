// vs-fork MFA token helpers. Plan 1.5 v1.2.1 Task 3.
//
// Three audiences:
//   "vs-declaration"   — full session JWT; jti = user_sessions.id
//   "mfa-challenge"    — single-use challenge for /api/auth/mfa/challenge
//   "mfa-enrolment"    — single-use challenge for /api/auth/mfa/enrol*
//
// Single-use enforcement: the JWT signature + audience binds the
// caller's identity, but the actual single-use check is the
// MfaChallengeNonce row referenced by jti. Either rejection mode
// (expired JWT, missing/consumed/wrong-aud nonce) results in 401.
//
// We reuse process.env.JWT_SECRET (the same secret used by
// upstream's makeJWT/decodeJWT) so we don't multiply key
// management surface.

const JWT = require("jsonwebtoken");
const { MfaChallengeNonce } = require("../../models/mfaChallengeNonce");

const SESSION_AUD = "vs-declaration";
const CHALLENGE_AUD = "mfa-challenge";
const ENROLMENT_AUD = "mfa-enrolment";
const CHALLENGE_TTL_SECONDS = 5 * 60;

function requireSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is unset");
  }
  return process.env.JWT_SECRET;
}

/**
 * Mint a one-time challenge token plus its backing nonce row.
 *
 * Returns { token, jti, expires_at }.
 */
async function issueChallengeToken({
  userId,
  aud,
  remoteIp = null,
  userAgent = null,
}) {
  if (aud !== CHALLENGE_AUD && aud !== ENROLMENT_AUD) {
    throw new Error(`issueChallengeToken: bad aud ${aud}`);
  }
  const { jti, expires_at } = await MfaChallengeNonce.create({
    userId,
    aud,
    ttlSeconds: CHALLENGE_TTL_SECONDS,
    remoteIp,
    userAgent,
  });
  const token = JWT.sign(
    {},
    requireSecret(),
    {
      audience: aud,
      subject: String(userId),
      jwtid: jti,
      expiresIn: CHALLENGE_TTL_SECONDS,
    }
  );
  return { token, jti, expires_at };
}

/**
 * Verify a challenge token's signature, audience, and nonce row.
 * Atomically consumes the nonce on success. Returns
 *   { ok: true, user_id }
 *   { ok: false, reason: "bad_token" | "expired" | "wrong_aud"
 *               | "already_consumed" | "unknown" }.
 */
async function consumeChallengeToken(token, expectedAud) {
  if (!token) return { ok: false, reason: "bad_token" };
  let decoded;
  try {
    decoded = JWT.verify(token, requireSecret(), {
      audience: expectedAud,
      algorithms: ["HS256"],
    });
  } catch (e) {
    if (e.name === "TokenExpiredError") return { ok: false, reason: "expired" };
    return { ok: false, reason: "bad_token" };
  }
  const jti = decoded.jti;
  if (!jti) return { ok: false, reason: "bad_token" };
  const userIdFromJwt = parseInt(decoded.sub, 10);
  if (!Number.isFinite(userIdFromJwt)) {
    return { ok: false, reason: "bad_token" };
  }

  const consumeResult = await MfaChallengeNonce.consume(jti, expectedAud);
  if (!consumeResult.ok) {
    return { ok: false, reason: consumeResult.reason };
  }

  return { ok: true, user_id: userIdFromJwt };
}

/**
 * Mint a full session JWT bound to a user_sessions row id (ULID).
 */
function issueSessionToken({ userId, sessionId, expiresAt }) {
  const ttlSeconds = Math.max(
    1,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
  );
  return JWT.sign(
    {},
    requireSecret(),
    {
      audience: SESSION_AUD,
      subject: String(userId),
      jwtid: sessionId,
      expiresIn: ttlSeconds,
    }
  );
}

/**
 * Verify a full session JWT (signature + audience). Returns
 *   { ok: true, user_id, session_id }
 *   { ok: false, reason: "bad_token" | "expired" | "wrong_aud" }.
 *
 * Caller MUST then look up the user_sessions row and reject if
 * revoked / expired / missing — that is requireFullAuth's job.
 */
function verifySessionToken(token) {
  if (!token) return { ok: false, reason: "bad_token" };
  try {
    const decoded = JWT.verify(token, requireSecret(), {
      audience: SESSION_AUD,
      algorithms: ["HS256"],
    });
    if (!decoded.jti || !decoded.sub) {
      return { ok: false, reason: "bad_token" };
    }
    const userId = parseInt(decoded.sub, 10);
    if (!Number.isFinite(userId)) return { ok: false, reason: "bad_token" };
    return { ok: true, user_id: userId, session_id: decoded.jti };
  } catch (e) {
    if (e.name === "TokenExpiredError") return { ok: false, reason: "expired" };
    return { ok: false, reason: "bad_token" };
  }
}

module.exports = {
  issueChallengeToken,
  consumeChallengeToken,
  issueSessionToken,
  verifySessionToken,
  SESSION_AUD,
  CHALLENGE_AUD,
  ENROLMENT_AUD,
  CHALLENGE_TTL_SECONDS,
};
