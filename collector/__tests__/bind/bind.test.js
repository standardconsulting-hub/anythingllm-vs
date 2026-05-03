// vs-fork Plan 2 §D — collector loopback bind assertion.
//
// The collector must NEVER bind to all interfaces. The
// AnythingLLM server reaches it via 127.0.0.1:8888; binding
// to 0.0.0.0 (or omitting the host arg) exposes a client-
// material-adjacent service to the LAN, bypassing Plan 2's
// network boundary. This test fails if a future edit drops
// the explicit loopback bind.
//
// Runs with plain node (no jest). Invoke with:
//   node collector/__tests__/bind/bind.test.js
//
// Exit 0 = pass; non-zero = fail.

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.join(__dirname, "..", "..", "index.js");
const src = fs.readFileSync(indexPath, "utf8");

const errors = [];

// Assert: app.listen takes "127.0.0.1" as its second argument.
const loopbackRegex = /app\s*[\s\S]*?\.listen\s*\(\s*8888\s*,\s*["']127\.0\.0\.1["']/;
if (!loopbackRegex.test(src)) {
  errors.push(
    "collector index.js .listen(8888, ...) is missing the explicit '127.0.0.1' host arg.\n" +
      "        Plan 2 §D requires loopback-only bind; binding to 0.0.0.0 exposes the\n" +
      "        collector to LAN, bypassing the network boundary."
  );
}

// Assert: no `process.env.COLLECTOR_HOST` reads (env override could re-expose).
if (/process\.env\.COLLECTOR_HOST/.test(src)) {
  errors.push(
    "collector index.js references process.env.COLLECTOR_HOST.\n" +
      "        Plan 2 §D forbids env-override of the bind host (a misconfig or\n" +
      "        attacker-controlled env could re-expose the listener)."
  );
}

if (errors.length) {
  console.error("FAIL: collector bind assertion (Plan 2 §D)");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

console.log("PASS: collector bind is loopback-only (127.0.0.1:8888)");
