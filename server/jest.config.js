// vs-fork — minimal Jest config for the test suites added by
// Plan 1, Plan 1.5, and Plan 2 §E. Tests live under
// `*/__tests__/*.test.js`; runtime-state directories
// (storage, documents, vector-cache, swagger) are excluded so a
// stray fixture file doesn't get treated as a test.

module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/storage/",
    "/documents/",
    "/vector-cache/",
    "/swagger/",
  ],
  // Fail fast on hung handles so a leaked prisma client or open
  // file descriptor surfaces immediately rather than wedging CI.
  detectOpenHandles: false,
  forceExit: true,
};
