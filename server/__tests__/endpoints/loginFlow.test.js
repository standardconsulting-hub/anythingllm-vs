// vs-fork login-flow test for Plan 1.5 Task 4. Asserts that
// /api/request-token now returns a single-use challenge token
// (aud=mfa-enrolment if user not yet enrolled, mfa-challenge
// otherwise) instead of a full session JWT.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

// Stub the upstream model-map module: its constructor fires an
// async fetch/file-write that outlives the test and makes Jest's
// "cannot log after tests are done" rule fail the suite. The
// login flow doesn't need it.
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));

const prisma = require("../../utils/prisma");
const { SystemSettings } = require("../../models/systemSettings");
const { systemEndpoints } = require("../../endpoints/system");
const JWT = require("jsonwebtoken");

// Tiny app harness — only needs to capture the /request-token POST
// and let us invoke its handler with fake req/res.
function fakeApp() {
  const routes = new Map();
  return {
    routes,
    post(path, ...rest) {
      // upstream system.js sometimes registers (path, handler) and
      // sometimes (path, [middlewares], handler). We only care
      // about the no-middleware /request-token form here.
      const handler = rest[rest.length - 1];
      const middlewares = rest.length > 1 ? rest[0] : [];
      routes.set(`POST ${path}`, { middlewares, handler });
    },
    get() {},
    put() {},
    delete() {},
    patch() {},
    all() {},
    use() {},
    async invoke(method, path, { body = {}, headers = {} } = {}) {
      const route = routes.get(`${method} ${path}`);
      if (!route) throw new Error(`no route ${method} ${path}`);
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
        let nextCalled = false;
        await new Promise((resolve, reject) => {
          try {
            const maybe = fn(req, res, (err) => {
              if (err) return reject(err);
              nextCalled = true;
              resolve();
            });
            if (maybe && typeof maybe.then === "function") {
              maybe.then(() => resolve(), reject);
            }
          } catch (e) {
            reject(e);
          }
        });
        void nextCalled;
      }
      return res;
    },
  };
}

async function makeUser({ password, ...overrides }) {
  const bcryptjs = require("bcryptjs");
  const username = `vs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.users.create({
    data: {
      username,
      password: bcryptjs.hashSync(password, 10),
      seen_recovery_codes: true, // skip the recovery-codes side-trip
      ...overrides,
    },
  });
}

describe("POST /api/request-token (Plan 1.5 v1.2.1 Task 4)", () => {
  let app;
  let testUserIds = [];
  let multiUserSpy;
  let telemetrySpy;

  beforeAll(() => {
    multiUserSpy = jest
      .spyOn(SystemSettings, "isMultiUserMode")
      .mockResolvedValue(true);
    // Telemetry tries to read SystemSettings telemetry_id; stub
    // sendTelemetry to a no-op so the login flow doesn't write
    // outbound. The DB-level telemetry id setting is unrelated.
    const { Telemetry } = require("../../models/telemetry");
    telemetrySpy = jest
      .spyOn(Telemetry, "sendTelemetry")
      .mockResolvedValue(undefined);
    app = fakeApp();
    systemEndpoints(app);
  });

  afterAll(() => {
    multiUserSpy?.mockRestore?.();
    telemetrySpy?.mockRestore?.();
  });

  afterEach(async () => {
    if (testUserIds.length) {
      await prisma.users.deleteMany({ where: { id: { in: testUserIds } } });
      testUserIds = [];
    }
  });

  it("password OK + not enrolled: returns needs_enrolment + mfa-enrolment challenge token (no full JWT)", async () => {
    const password = "password123";
    const u = await makeUser({ password, totp_verified_at: null });
    testUserIds.push(u.id);
    const res = await app.invoke("POST", "/request-token", {
      body: { username: u.username, password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.needs_enrolment).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.challenge_token.split(".")).toHaveLength(3);
    const decoded = JWT.verify(res.body.challenge_token, process.env.JWT_SECRET);
    expect(decoded.aud).toBe("mfa-enrolment");
    expect(parseInt(decoded.sub, 10)).toBe(u.id);
  });

  it("password OK + already enrolled: returns needs_totp + mfa-challenge challenge token (no full JWT)", async () => {
    const password = "password123";
    const u = await makeUser({ password, totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const res = await app.invoke("POST", "/request-token", {
      body: { username: u.username, password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.needs_totp).toBe(true);
    expect(res.body.needs_enrolment).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    const decoded = JWT.verify(res.body.challenge_token, process.env.JWT_SECRET);
    expect(decoded.aud).toBe("mfa-challenge");
  });

  it("wrong password: unchanged behaviour — valid:false, no challenge_token", async () => {
    const password = "password123";
    const u = await makeUser({ password, totp_verified_at: new Date() });
    testUserIds.push(u.id);
    const res = await app.invoke("POST", "/request-token", {
      body: { username: u.username, password: "wrong" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.token).toBeNull();
    expect(res.body.challenge_token).toBeUndefined();
  });

  it("unknown username: unchanged behaviour — valid:false", async () => {
    const res = await app.invoke("POST", "/request-token", {
      body: { username: "vs-test-no-such-user", password: "anything" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(false);
  });
});
