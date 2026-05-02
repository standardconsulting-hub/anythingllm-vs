// vs-fork end-to-end first-run flow. Plan 1.5 v1.2.1 Task 6.
//
// Walks the full path from "no user yet" to "fully MFA-enrolled
// session JWT working against a protected route":
//
//   1. POST /system/enable-multi-user        — creates COFA user;
//                                              returns mfa-enrolment
//                                              challenge_token.
//   2. POST /api/auth/mfa/enrol              — seeds totp_secret,
//                                              returns next-leg
//                                              challenge_token.
//   3. POST /api/auth/mfa/enrol/confirm      — verifies first code,
//                                              seeds backup codes,
//                                              sets totp_verified_at.
//   4. POST /api/request-token               — returns mfa-challenge
//                                              token (re-login).
//   5. POST /api/auth/mfa/challenge          — mints session JWT.
//   6. validatedRequest accepts the JWT      — protected route is
//                                              now reachable.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

// Stub the upstream model-map module — same reason as
// loginFlow.test.js (its constructor fires async work that
// outlives the test).
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));

const prisma = require("../../utils/prisma");
const { authenticator } = require("otplib");
const totp = require("../../utils/totp");
const { systemEndpoints } = require("../../endpoints/system");
const { mfaEndpoints } = require("../../endpoints/auth/mfa");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const { SystemSettings } = require("../../models/systemSettings");
const { Telemetry } = require("../../models/telemetry");

// ---- fake-app harness ----------------------------------------

function fakeApp() {
  const routes = new Map();
  const noop = () => {};
  return {
    routes,
    post(path, ...rest) {
      const handler = rest[rest.length - 1];
      const middlewares = rest.length > 1 ? rest[0] : [];
      routes.set(`POST ${path}`, { middlewares, handler });
    },
    get(path, ...rest) {
      const handler = rest[rest.length - 1];
      const middlewares = rest.length > 1 ? rest[0] : [];
      routes.set(`GET ${path}`, { middlewares, handler });
    },
    put: noop,
    delete: noop,
    patch: noop,
    all: noop,
    use: noop,
    async invoke(method, path, { body = {}, headers = {} } = {}) {
      const route = routes.get(`${method} ${path}`);
      if (!route) throw new Error(`no route ${method} ${path}`);
      const req = {
        body,
        headers,
        ip: headers["x-forwarded-for"] || "127.0.0.1",
        path,
        originalUrl: path,
        connection: {},
        header: (n) => headers[n] || headers[n.toLowerCase()] || null,
      };
      const res = {
        statusCode: 200,
        body: undefined,
        locals: {},
        set: jest.fn().mockReturnThis(),
        sendStatus(c) {
          this.statusCode = c;
          return { end() {} };
        },
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
        await new Promise((resolve, reject) => {
          try {
            const maybe = fn(req, res, (err) => {
              if (err) return reject(err);
              resolve();
            });
            if (maybe && typeof maybe.then === "function") {
              maybe.then(() => resolve(), reject);
            }
          } catch (e) {
            reject(e);
          }
        });
      }
      return res;
    },
  };
}

// ---- test ----------------------------------------------------

describe("First-run flow: enable-multi-user → enrol → challenge → protected route", () => {
  let app;
  let createdUserId = null;
  let multiUserSpy;
  let telemetrySpy;
  let updateEnvSpy;
  let updatedSettings = null;

  beforeAll(() => {
    // Force multi-user OFF on the first call (so enable-multi-user
    // can run); then ON once it's been enabled.
    multiUserSpy = jest
      .spyOn(SystemSettings, "isMultiUserMode")
      .mockImplementation(async () => updatedSettings?.multi_user_mode === true);
    // Capture _updateSettings without actually mutating shared
    // SystemSettings.
    jest.spyOn(SystemSettings, "_updateSettings").mockImplementation(async (s) => {
      updatedSettings = { ...(updatedSettings || {}), ...s };
      return updatedSettings;
    });
    telemetrySpy = jest
      .spyOn(Telemetry, "sendTelemetry")
      .mockResolvedValue(undefined);
    // updateENV writes .env on disk; stub.
    updateEnvSpy = jest
      .spyOn(require("../../utils/helpers/updateENV"), "updateENV")
      .mockResolvedValue({});

    app = fakeApp();
    systemEndpoints(app);
    mfaEndpoints(app);

    // Mount validatedRequest as a fake protected route to assert
    // we can actually pass through after enrolment.
    app.post(
      "/api/system/protected-test",
      [validatedRequest],
      async (_req, res) => {
        res.status(200).json({ ok: true, user_id: res.locals.user.id });
      }
    );
  });

  afterAll(async () => {
    if (createdUserId) {
      await prisma.users.deleteMany({ where: { id: createdUserId } });
    }
    multiUserSpy?.mockRestore?.();
    telemetrySpy?.mockRestore?.();
    updateEnvSpy?.mockRestore?.();
    jest.restoreAllMocks();
  });

  it("walks the full first-run path end-to-end", async () => {
    // ----- Step 1: enable-multi-user -----
    const r1 = await app.invoke("POST", "/system/enable-multi-user", {
      body: { username: "vs-test-cofa", password: "supersecret-password-1" },
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.body.success).toBe(true);
    expect(r1.body.needs_enrolment).toBe(true);
    expect(r1.body.challenge_token.split(".")).toHaveLength(3);
    const cofa = await prisma.users.findUnique({
      where: { username: "vs-test-cofa" },
    });
    createdUserId = cofa.id;
    expect(cofa.totp_verified_at).toBeNull();

    let challengeToken = r1.body.challenge_token;

    // ----- Step 2: /enrol -----
    const r2 = await app.invoke("POST", "/auth/mfa/enrol", {
      body: { challenge_token: challengeToken },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.body.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    expect(r2.body.qr_data_url).toMatch(/^data:image\/png;base64,/);
    challengeToken = r2.body.challenge_token;
    const seeded = await prisma.users.findUnique({ where: { id: cofa.id } });
    expect(seeded.totp_secret_ciphertext).not.toBeNull();
    const secret = totp.decryptSecret(seeded.totp_secret_ciphertext);

    // ----- Step 3: /enrol/confirm -----
    const code3 = authenticator.generate(secret);
    const r3 = await app.invoke("POST", "/auth/mfa/enrol/confirm", {
      body: { challenge_token: challengeToken, code: code3 },
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.body.enrolled).toBe(true);
    expect(r3.body.backup_codes).toHaveLength(10);
    const enrolled = await prisma.users.findUnique({
      where: { id: cofa.id },
    });
    expect(enrolled.totp_verified_at).not.toBeNull();
    const backupCodes = r3.body.backup_codes;

    // ----- Step 4: /request-token (after enrolment) -----
    const r4 = await app.invoke("POST", "/request-token", {
      body: { username: "vs-test-cofa", password: "supersecret-password-1" },
    });
    expect(r4.statusCode).toBe(200);
    expect(r4.body.needs_totp).toBe(true);
    expect(r4.body.token).toBeUndefined();
    challengeToken = r4.body.challenge_token;

    // ----- Step 5: /challenge with backup code (avoids the 30s
    // TOTP same-window race that would otherwise reject the code
    // already used in Step 3). -----
    const r5 = await app.invoke("POST", "/auth/mfa/challenge", {
      body: {
        challenge_token: challengeToken,
        code: backupCodes[0],
        use_backup_code: true,
      },
    });
    expect(r5.statusCode).toBe(200);
    expect(r5.body.session_token.split(".")).toHaveLength(3);
    const sessionToken = r5.body.session_token;

    // ----- Step 6: hit a protected route through validatedRequest -----
    const r6 = await app.invoke("POST", "/api/system/protected-test", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    expect(r6.statusCode).toBe(200);
    expect(r6.body.ok).toBe(true);
    expect(r6.body.user_id).toBe(cofa.id);
  });
});
