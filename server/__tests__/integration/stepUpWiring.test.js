// vs-fork Plan 1.5 v1.2.1 Task 11.3.
//
// Smoke: confirms the requireFreshStepUp(5) wiring landed on the
// two endpoints we updated:
//   GET  /api/system/export-chats
//   POST /api/admin/user/:id
//
// The middleware semantics themselves are covered exhaustively
// in requireTotp.test.js + the integration test. This suite's
// job is to fail loudly if a future refactor accidentally drops
// requireFreshStepUp from either chain.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-12345";

jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: () => null },
}));

const prisma = require("../../utils/prisma");
const { systemEndpoints } = require("../../endpoints/system");
const { adminEndpoints } = require("../../endpoints/admin");
const { SystemSettings } = require("../../models/systemSettings");
const { Telemetry } = require("../../models/telemetry");
const { UserSession } = require("../../models/userSession");
const { issueSessionToken } = require("../../utils/auth/mfaTokens");

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
    async invoke(method, path, { body = {}, headers = {}, params = {} } = {}) {
      const route = routes.get(`${method} ${path}`);
      if (!route) throw new Error(`no route ${method} ${path}`);
      const req = {
        body,
        headers,
        params,
        query: {},
        ip: "127.0.0.1",
        path,
        originalUrl: path,
        connection: {},
        header: (n) => headers[n] || headers[n.toLowerCase()] || null,
      };
      const res = {
        statusCode: 200,
        body: undefined,
        locals: {},
        headersSent: false,
        set: jest.fn().mockReturnThis(),
        send(b) {
          this.body = b ?? null;
          return this;
        },
        sendStatus(c) {
          this.statusCode = c;
          this.body = null;
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

let app;
let admin;
let target;

async function authHeaders(user, { stale = false } = {}) {
  const session = await UserSession.create({ userId: user.id });
  if (!stale) {
    await UserSession.markStepUp(session.id);
  } else {
    // last_step_up_at left null → middleware treats as stale.
  }
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

beforeAll(() => {
  jest.spyOn(SystemSettings, "isMultiUserMode").mockResolvedValue(true);
  jest.spyOn(Telemetry, "sendTelemetry").mockResolvedValue(undefined);
  app = fakeApp();
  systemEndpoints(app);
  adminEndpoints(app);
});

afterAll(async () => {
  await prisma.user_sessions.deleteMany({
    where: { user_id: { in: [admin?.id, target?.id].filter(Boolean) } },
  });
  await prisma.users.deleteMany({
    where: { id: { in: [admin?.id, target?.id].filter(Boolean) } },
  });
  jest.restoreAllMocks();
});

beforeAll(async () => {
  admin = await prisma.users.create({
    data: {
      username: `vs-step-admin-${Date.now()}`,
      password: "irrelevant",
      role: "admin",
      totp_verified_at: new Date(),
    },
  });
  target = await prisma.users.create({
    data: {
      username: `vs-step-target-${Date.now()}`,
      password: "irrelevant",
      role: "default",
      totp_verified_at: new Date(),
    },
  });
});

describe("Plan 1.5 Task 11: step-up wiring", () => {
  it("GET /system/export-chats with stale step-up returns 403 needs_step_up", async () => {
    const { headers } = await authHeaders(admin, { stale: true });
    const r = await app.invoke("GET", "/system/export-chats", { headers });
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe("needs_step_up");
    expect(r.body.needs_totp).toBe(true);
  });

  it("GET /system/export-chats with fresh step-up gets past requireFreshStepUp", async () => {
    const { headers } = await authHeaders(admin, { stale: false });
    const r = await app.invoke("GET", "/system/export-chats", { headers });
    // Either the handler ran (200) or it errored downstream — what
    // we care about is that the gate did NOT reject with 403
    // needs_step_up. (The handler's internal data dependencies
    // are out of scope for a wiring test.)
    expect(r.statusCode).not.toBe(403);
    if (typeof r.body === "object" && r.body !== null) {
      expect(r.body.error).not.toBe("needs_step_up");
    }
  });

  it("POST /admin/user/:id with stale step-up returns 403 needs_step_up", async () => {
    const { headers } = await authHeaders(admin, { stale: true });
    const r = await app.invoke("POST", "/admin/user/:id", {
      headers,
      params: { id: String(target.id) },
      body: { bio: "updated" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe("needs_step_up");
  });

  it("POST /admin/user/:id with fresh step-up gets past requireFreshStepUp", async () => {
    const { headers } = await authHeaders(admin, { stale: false });
    const r = await app.invoke("POST", "/admin/user/:id", {
      headers,
      params: { id: String(target.id) },
      body: { bio: "updated" },
    });
    expect(r.statusCode).not.toBe(403);
    if (typeof r.body === "object" && r.body !== null) {
      expect(r.body.error).not.toBe("needs_step_up");
    }
  });
});
