// vs-fork TOTP service tests. Plan 1.5 v1.2.1 Task 2.

// Test env setup — matches the pattern in other __tests__/ files
// (storage paths, NODE_ENV) and pins SIG_KEY/SIG_SALT so the
// EncryptionManager round-trip is deterministic.
process.env.STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SIG_KEY = process.env.SIG_KEY || "x".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "y".repeat(64);

const totp = require("../index");
const { authenticator } = require("otplib");

describe("TOTP service", () => {
  describe("generateSecret", () => {
    it("returns a base32 string of reasonable length", () => {
      const secret = totp.generateSecret();
      expect(typeof secret).toBe("string");
      expect(secret.length).toBeGreaterThanOrEqual(16);
      expect(secret).toMatch(/^[A-Z2-7]+=*$/i);
    });
  });

  describe("generateOtpauthUrl", () => {
    it("produces a valid otpauth:// URI", () => {
      const secret = totp.generateSecret();
      const url = totp.generateOtpauthUrl(secret, "alice@example.com");
      expect(url).toMatch(/^otpauth:\/\/totp\//);
      expect(url).toMatch(/secret=/);
      expect(url).toContain("VS%20Declaration");
    });
  });

  describe("verify", () => {
    it("accepts a freshly-generated code", () => {
      const secret = totp.generateSecret();
      const code = authenticator.generate(secret);
      const result = totp.verify(secret, code);
      expect(result.valid).toBe(true);
      expect(typeof result.counter).toBe("bigint");
      expect(result.reason).toBeNull();
    });

    it("rejects a wrong code with reason=invalid", () => {
      const secret = totp.generateSecret();
      const result = totp.verify(secret, "000000");
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid");
      expect(result.counter).toBeNull();
    });

    it("rejects a replayed code with reason=replay when lastUsedCounter is set", () => {
      const secret = totp.generateSecret();
      const code = authenticator.generate(secret);

      // First verify succeeds; capture the counter.
      const first = totp.verify(secret, code);
      expect(first.valid).toBe(true);

      // Replaying the same code with lastUsedCounter = first.counter
      // must be rejected with reason: "replay".
      const replay = totp.verify(secret, code, {
        lastUsedCounter: first.counter,
      });
      expect(replay.valid).toBe(false);
      expect(replay.reason).toBe("replay");
      expect(replay.counter).toEqual(first.counter);
    });

    it("accepts a fresh code when lastUsedCounter is set to a smaller value", () => {
      const secret = totp.generateSecret();
      const code = authenticator.generate(secret);
      const result = totp.verify(secret, code, {
        lastUsedCounter: 0n,
      });
      expect(result.valid).toBe(true);
      expect(result.counter > 0n).toBe(true);
    });
  });

  describe("consumeTotpCounter (compare-and-swap contract)", () => {
    // Build a fake prisma stub that mimics $executeRaw rowcount
    // semantics. We test the semantics here; integration with real
    // Prisma is covered by the model layer + integration tests.
    const makeFakePrisma = (initialCounter) => {
      let stored = initialCounter;
      return {
        get stored() {
          return stored;
        },
        async $executeRaw(_strings, newCounter, _userId, _newCounterAgain) {
          // Tagged template — the function receives the values in
          // declaration order. Order in the template is:
          // ${counter}, ${userId}, ${counter}.
          const candidate = newCounter;
          if (stored === null || stored === undefined || stored < candidate) {
            stored = candidate;
            return 1;
          }
          return 0;
        },
      };
    };

    it("returns true and updates when candidate counter > stored", async () => {
      const fp = makeFakePrisma(5n);
      const ok = await totp.consumeTotpCounter(fp, 1, 7n);
      expect(ok).toBe(true);
      expect(fp.stored).toBe(7n);
    });

    it("returns false and does not mutate when candidate <= stored", async () => {
      const fp = makeFakePrisma(10n);
      const ok = await totp.consumeTotpCounter(fp, 1, 10n);
      expect(ok).toBe(false);
      expect(fp.stored).toBe(10n);
    });

    it("returns true when stored is null (first ever use)", async () => {
      const fp = makeFakePrisma(null);
      const ok = await totp.consumeTotpCounter(fp, 1, 42n);
      expect(ok).toBe(true);
      expect(fp.stored).toBe(42n);
    });

    it("under concurrent calls, only one wins", async () => {
      const fp = makeFakePrisma(0n);
      // Simulate two parallel callers trying to consume the same
      // counter value. Only one can succeed because the fake prisma
      // (like SQL UPDATE) is atomic.
      const [a, b] = await Promise.all([
        totp.consumeTotpCounter(fp, 1, 10n),
        totp.consumeTotpCounter(fp, 1, 10n),
      ]);
      expect([a, b].filter(Boolean).length).toBe(1);
      expect(fp.stored).toBe(10n);
    });
  });

  describe("backup codes", () => {
    it("generateBackupCodes returns 10 distinct strings >= 8 chars", () => {
      const codes = totp.generateBackupCodes();
      expect(codes).toHaveLength(10);
      const unique = new Set(codes);
      expect(unique.size).toBe(10);
      codes.forEach((c) => expect(c.length).toBeGreaterThanOrEqual(8));
    });

    it("hashBackupCodes returns 10 bcrypt hashes that round-trip with compareBackupCode", async () => {
      const codes = totp.generateBackupCodes();
      const hashes = await totp.hashBackupCodes(codes);
      expect(hashes).toHaveLength(10);
      hashes.forEach((h) => expect(h).toMatch(/^\$2[aby]\$\d+\$/));

      // Each plaintext matches exactly one hash.
      for (let i = 0; i < codes.length; i++) {
        expect(await totp.compareBackupCode(codes[i], hashes[i])).toBe(true);
        // Wrong code does not match.
        expect(await totp.compareBackupCode("nope-not-a-code", hashes[i])).toBe(
          false
        );
      }
    });
  });

  describe("encryptSecret / decryptSecret round trip", () => {
    it("plaintext survives encrypt → decrypt", () => {
      const secret = totp.generateSecret();
      const ciphertext = totp.encryptSecret(secret);
      expect(typeof ciphertext).toBe("string");
      expect(ciphertext).not.toEqual(secret);
      const back = totp.decryptSecret(ciphertext);
      expect(back).toBe(secret);
    });
  });
});
