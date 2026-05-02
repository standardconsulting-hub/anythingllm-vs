// vs-fork MFA endpoint tests. Plan 1.5 v1.2.1 Task 3.
//
// We don't pull in supertest / express for tests. Instead a tiny
// harness captures app.post(path, [middlewares], handler) tuples
// and runs the middleware chain manually against fake req/res.
// The middlewares + handlers under test are all CommonJS, so this
// keeps the surface flat and predictable.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

const prisma = require("../../../utils/prisma");
const totp = require("../../../utils/totp");
const { authenticator } = require("otplib");
const { mfaEndpoints } = require("../mfa");
const {
  issueChallengeToken,
  issueSessionToken,
  CHALLENGE_AUD,
  ENROLMENT_AUD,
} = require("../../../utils/auth/mfaTokens");
const { UserSession } = require("../../../models/userSession");
const { UserBackupCode } = require("../../../models/userBackupCode");

// ---- harness --------------------------------------------------

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    post(path, middlewares, handler) {
      routes.set(`POST ${path}`, { middlewares, handler });
    },
    async invoke(method, path, { body = {}, headers = {}, locals = {} } = {}) {
      const key = `${method} ${path}`;
      const route = routes.get(key);
      if (!route) throw new Error(`no route for ${key}`);
      const req = {
        body,
        headers,
        ip: headers["x-forwarded-for"] || "127.0.0.1",
        path,
        connection: {},
        header: (n) => headers[n] || headers[n.toLowerCase()] || null,
      };
      const res = {
        statusCode: 200,
        body: undefined,
        headersSent: false,
        locals: { ...locals },
        set: jest.fn().mockReturnThis(),
        status(c) {
          this.statusCode = c;
          return this;
        },
        json(b) {
          this.body = b;
          return this;
        },
      };
      const chain = route.middlewares.concat([route.handler]);
      for (const fn of chain) {
        if (res.body !== undefined) break;
        let nextCalled = false;
        await new Promise((resolve, reject) => {
          try {
            const maybe = fn(req, res, (err) => {
              if (err) return reject(err);
              nextCalled = true;
              resolve();
            });
            // Async middlewares may not call next() synchronously;
            // handle promises returned from them:
            if (maybe && typeof maybe.then === "function") {
              maybe.then(() => resolve(), reject);
            }
          } catch (e) {
            reject(e);
          }
        });
        if (!nextCalled && res.body === undefined) {
          // Middleware finished without next() but didn't write a
          // response either — treat as silent success and continue.
        }
      }
      return res;
    },
  };
}

async function makeUser(overrides = {}) {
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: { username, password: "irrelevant", ...overrides },
  });
}

async function fullAuthHeaders(user) {
  const session = await UserSession.create({ userId: user.id });
  const token = issueSessionToken({
    userId: user.id,
    sessionId: session.id,
    expiresAt: session.expires_at,
  });
  return {
    headers: { Authorization: `Bearer ${token}` },
    session,
  };
}

// ---- tests ----------------------------------------------------

describe("MFA endpoints", () => {
  let app;
  let testUserIds = [];

  beforeAll(() => {
    app = fakeApp();
    mfaEndpoints(app);
  });

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.mfa_attempt_log.deleteMany({
        where: { user_id: { in: testUserIds } },
      });
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  describe("POST /api/auth/mfa/enrol", () => {
    it("rejects without a challenge_token", async () => {
      const res = await app.invoke("POST", "/auth/mfa/enrol", { body: {} });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe("challenge_token_invalid");
    });

    it("rejects with a challenge_token of the wrong audience", async () => {
      const u = await makeUser();
      testUserIds.push(u.id);
      const { token } = await issueChallengeToken({
        userId: u.id,
        aud: CHALLENGE_AUD,
      });
      const res = await app.invoke("POST", "/auth/mfa/enrol", {
        body: { challenge_token: token },
      });
      expect(res.statusCode).toBe(401);
    });

    it("with a valid enrolment token: returns otpauth_url + qr + a fresh challenge_token, stores ciphertext", async () => {
      const u = await makeUser();
      testUserIds.push(u.id);
      const { token } = await issueChallengeToken({
        userId: u.id,
        aud: ENROLMENT_AUD,
      });
      const res = await app.invoke("POST", "/auth/mfa/enrol", {
        body: { challenge_token: token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
      expect(res.body.qr_data_url).toMatch(/^data:image\/png;base64,/);
      expect(res.body.challenge_token.split(".")).toHaveLength(3);
      const after = await prisma.users.findUnique({ where: { id: u.id } });
      expect(after.totp_secret_ciphertext).not.toBeNull();
      expect(after.totp_verified_at).toBeNull();
    });
  });

  describe("POST /api/auth/mfa/enrol/confirm", () => {
    it("with valid TOTP code: sets totp_verified_at, returns 10 backup codes, consumes counter", async () => {
      const u = await makeUser();
      testUserIds.push(u.id);

      // Step 1 — enrol to seed the secret + get the next-leg token.
      const { token: enrolTok } = await issueChallengeToken({
        userId: u.id,
        aud: ENROLMENT_AUD,
      });
      const enrolRes = await app.invoke("POST", "/auth/mfa/enrol", {
        body: { challenge_token: enrolTok },
      });
      const confirmTok = enrolRes.body.challenge_token;

      // Step 2 — confirm with a freshly-generated code.
      const seeded = await prisma.users.findUnique({ where: { id: u.id } });
      const secret = totp.decryptSecret(seeded.totp_secret_ciphertext);
      const code = authenticator.generate(secret);
      const res = await app.invoke("POST", "/auth/mfa/enrol/confirm", {
        body: { challenge_token: confirmTok, code },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.enrolled).toBe(true);
      expect(res.body.backup_codes).toHaveLength(10);
      const after = await prisma.users.findUnique({ where: { id: u.id } });
      expect(after.totp_verified_at).not.toBeNull();
      expect(after.totp_last_used_counter).not.toBeNull();
    });

    it("with wrong code: rejects with reason=invalid; no totp_verified_at", async () => {
      const u = await makeUser();
      testUserIds.push(u.id);
      const { token } = await issueChallengeToken({
        userId: u.id,
        aud: ENROLMENT_AUD,
      });
      // Skip the actual /enrol call — just synthesise a stored
      // ciphertext directly so we test the reject path.
      const secret = totp.generateSecret();
      const ct = totp.encryptSecret(secret);
      await prisma.users.update({
        where: { id: u.id },
        data: { totp_secret_ciphertext: ct },
      });
      const res = await app.invoke("POST", "/auth/mfa/enrol/confirm", {
        body: { challenge_token: token, code: "000000" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.reason).toBe("invalid");
      const after = await prisma.users.findUnique({ where: { id: u.id } });
      expect(after.totp_verified_at).toBeNull();
    });
  });

  describe("POST /api/auth/mfa/challenge", () => {
    async function freshlyEnrolledUser() {
      const u = await makeUser();
      testUserIds.push(u.id);
      const { token: enrolTok } = await issueChallengeToken({
        userId: u.id,
        aud: ENROLMENT_AUD,
      });
      const enrolRes = await app.invoke("POST", "/auth/mfa/enrol", {
        body: { challenge_token: enrolTok },
      });
      const confirmTok = enrolRes.body.challenge_token;
      const seeded = await prisma.users.findUnique({ where: { id: u.id } });
      const secret = totp.decryptSecret(seeded.totp_secret_ciphertext);
      const code = authenticator.generate(secret);
      const confirmRes = await app.invoke(
        "POST",
        "/auth/mfa/enrol/confirm",
        { body: { challenge_token: confirmTok, code } }
      );
      return { user: u, secret, backup_codes: confirmRes.body.backup_codes };
    }

    it("with TOTP code: mints a session JWT + creates user_sessions row", async () => {
      const { user, secret } = await freshlyEnrolledUser();
      const { token: chalTok } = await issueChallengeToken({
        userId: user.id,
        aud: CHALLENGE_AUD,
      });
      // Wait one window so the previous-window-locked counter
      // doesn't immediately reject the new code.
      await new Promise((r) => setTimeout(r, 31_000));
      const code = authenticator.generate(secret);
      const res = await app.invoke("POST", "/auth/mfa/challenge", {
        body: { challenge_token: chalTok, code },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.session_token.split(".")).toHaveLength(3);
      const session = await UserSession.findActive(res.body.session_id);
      expect(session).not.toBeNull();
      // Initial step-up was implicit:
      expect(session.last_step_up_at).not.toBeNull();
    }, 45_000);

    it("with backup code: succeeds and decrements remaining count", async () => {
      const { user, backup_codes } = await freshlyEnrolledUser();
      const { token: chalTok } = await issueChallengeToken({
        userId: user.id,
        aud: CHALLENGE_AUD,
      });
      const res = await app.invoke("POST", "/auth/mfa/challenge", {
        body: {
          challenge_token: chalTok,
          code: backup_codes[0],
          use_backup_code: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const remaining = await UserBackupCode.countUnused(user.id);
      expect(remaining).toBe(9);
    });

    it("backup code reuse fails", async () => {
      const { user, backup_codes } = await freshlyEnrolledUser();
      // First use:
      const { token: t1 } = await issueChallengeToken({
        userId: user.id,
        aud: CHALLENGE_AUD,
      });
      await app.invoke("POST", "/auth/mfa/challenge", {
        body: {
          challenge_token: t1,
          code: backup_codes[0],
          use_backup_code: true,
        },
      });
      // Reuse:
      const { token: t2 } = await issueChallengeToken({
        userId: user.id,
        aud: CHALLENGE_AUD,
      });
      const res = await app.invoke("POST", "/auth/mfa/challenge", {
        body: {
          challenge_token: t2,
          code: backup_codes[0],
          use_backup_code: true,
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/auth/mfa/disable", () => {
    it("requires fresh step-up; without it returns 403 needs_step_up", async () => {
      const u = await makeUser({ totp_verified_at: new Date() });
      testUserIds.push(u.id);
      const { headers } = await fullAuthHeaders(u);
      // Don't markStepUp — should be rejected.
      const res = await app.invoke("POST", "/auth/mfa/disable", {
        headers,
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.needs_totp).toBe(true);
    });

    it("with fresh step-up: wipes secret, codes, sessions; sets must_rotate_password", async () => {
      const u = await makeUser({
        totp_verified_at: new Date(),
        totp_secret_ciphertext: "anything",
      });
      testUserIds.push(u.id);
      // Seed a backup code so we can confirm wipe.
      const codes = totp.generateBackupCodes();
      const hashes = await totp.hashBackupCodes(codes);
      await UserBackupCode.seed(u.id, hashes);
      // Auth + step-up:
      const { headers, session } = await fullAuthHeaders(u);
      await UserSession.markStepUp(session.id);
      // A second active session that must be revoked too:
      const otherSession = await UserSession.create({ userId: u.id });
      const res = await app.invoke("POST", "/auth/mfa/disable", {
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.disabled).toBe(true);
      expect(res.body.revoked_sessions).toBeGreaterThanOrEqual(2);
      const after = await prisma.users.findUnique({ where: { id: u.id } });
      expect(after.totp_secret_ciphertext).toBeNull();
      expect(after.totp_verified_at).toBeNull();
      expect(after.must_rotate_password).toBe(true);
      expect(await UserBackupCode.countUnused(u.id)).toBe(0);
      expect(await UserSession.findActive(otherSession.id)).toBeNull();
    });
  });

  describe("POST /api/auth/mfa/backup-codes/regenerate", () => {
    it("requires step-up; on success replaces all codes and returns 10 new ones", async () => {
      const u = await makeUser({
        totp_verified_at: new Date(),
        totp_secret_ciphertext: "anything",
      });
      testUserIds.push(u.id);
      // seed old codes
      const old = totp.generateBackupCodes();
      const oldHashes = await totp.hashBackupCodes(old);
      await UserBackupCode.seed(u.id, oldHashes);
      const { headers, session } = await fullAuthHeaders(u);
      await UserSession.markStepUp(session.id);
      const res = await app.invoke(
        "POST",
        "/auth/mfa/backup-codes/regenerate",
        { headers }
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.backup_codes).toHaveLength(10);
      // All NEW codes — none of the old plaintexts validates.
      expect(
        (await UserBackupCode.consumeIfValid(u.id, old[0])).ok
      ).toBe(false);
      // A new code DOES validate:
      const r = await UserBackupCode.consumeIfValid(
        u.id,
        res.body.backup_codes[0]
      );
      expect(r.ok).toBe(true);
    });
  });

  describe("POST /api/auth/mfa/sessions/revoke-all", () => {
    it("revokes every active session for the user AND sets must_rotate_password", async () => {
      const u = await makeUser({
        totp_verified_at: new Date(),
        totp_secret_ciphertext: "anything",
      });
      testUserIds.push(u.id);
      const { headers, session } = await fullAuthHeaders(u);
      await UserSession.markStepUp(session.id);
      const other = await UserSession.create({ userId: u.id });
      const res = await app.invoke(
        "POST",
        "/auth/mfa/sessions/revoke-all",
        { headers }
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.revoked_sessions).toBeGreaterThanOrEqual(2);
      expect(res.body.must_rotate_password).toBe(true);
      const after = await prisma.users.findUnique({ where: { id: u.id } });
      expect(after.must_rotate_password).toBe(true);
      expect(await UserSession.findActive(other.id)).toBeNull();
    });
  });

  describe("POST /api/auth/rotate-password (final-Codex BLOCK 2 closure)", () => {
    it("requires step-up; without it returns 403 needs_step_up", async () => {
      const u = await makeUser({
        totp_verified_at: new Date(),
        must_rotate_password: true,
      });
      testUserIds.push(u.id);
      const { headers } = await fullAuthHeaders(u); // no markStepUp
      const r = await app.invoke("POST", "/auth/rotate-password", {
        headers,
        body: { new_password: "another-good-password-1" },
      });
      expect(r.statusCode).toBe(403);
      expect(r.body.error).toBe("needs_step_up");
    });

    it("with fresh step-up: clears must_rotate_password and updates the password hash", async () => {
      const bcrypt = require("bcryptjs");
      const u = await makeUser({
        password: bcrypt.hashSync("old-pwd-original", 10),
        totp_verified_at: new Date(),
        must_rotate_password: true,
      });
      testUserIds.push(u.id);
      const { headers, session } = await fullAuthHeaders(u);
      await UserSession.markStepUp(session.id);
      const r = await app.invoke("POST", "/auth/rotate-password", {
        headers,
        body: { new_password: "another-good-password-1" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.body.rotated).toBe(true);
      const after = await prisma.users.findUnique({ where: { id: u.id } });
      expect(after.must_rotate_password).toBe(false);
      expect(bcrypt.compareSync("another-good-password-1", after.password)).toBe(true);
      expect(bcrypt.compareSync("old-pwd-original", after.password)).toBe(false);
    });

    it("rejects on missing or malformed new_password", async () => {
      const u = await makeUser({
        totp_verified_at: new Date(),
        must_rotate_password: true,
      });
      testUserIds.push(u.id);
      const { headers, session } = await fullAuthHeaders(u);
      await UserSession.markStepUp(session.id);
      const r1 = await app.invoke("POST", "/auth/rotate-password", {
        headers,
        body: {},
      });
      expect(r1.statusCode).toBe(400);
      expect(r1.body.error).toBe("missing_new_password");
      const r2 = await app.invoke("POST", "/auth/rotate-password", {
        headers,
        body: { new_password: "x" }, // too short for default complexity
      });
      expect(r2.statusCode).toBe(400);
      expect(r2.body.error).toBe("password_complexity");
    });
  });

  describe("Cross-endpoint replay (BLOCK #2 closure proof)", () => {
    it("same code submitted to /challenge and /step-up in parallel — only one wins", async () => {
      // Set up an enrolled user with a session and cached TOTP state.
      const u = await makeUser({ totp_verified_at: new Date() });
      testUserIds.push(u.id);
      const secret = totp.generateSecret();
      await prisma.users.update({
        where: { id: u.id },
        data: { totp_secret_ciphertext: totp.encryptSecret(secret) },
      });
      const { headers, session } = await fullAuthHeaders(u);
      await UserSession.markStepUp(session.id);
      const code = authenticator.generate(secret);
      // Build a fresh challenge token for the /challenge call.
      const { token: chalTok } = await issueChallengeToken({
        userId: u.id,
        aud: CHALLENGE_AUD,
      });
      const [a, b] = await Promise.all([
        app.invoke("POST", "/auth/mfa/challenge", {
          body: { challenge_token: chalTok, code },
        }),
        app.invoke("POST", "/auth/mfa/step-up", {
          headers,
          body: { code },
        }),
      ]);
      const ok = [a, b].filter((r) => r.statusCode === 200).length;
      const replay = [a, b].filter(
        (r) => r.statusCode === 400 && r.body.reason === "replay"
      ).length;
      expect(ok).toBe(1);
      expect(replay).toBe(1);
    });
  });
});
