// vs-fork Plan 2.5 §E: PostHog telemetry stripped.
//
// Pre-strip, this file imported posthog-node and POSTed events
// to PostHog's pubkey on every workspace, chat, document
// upload, and onboarding milestone. Post-strip, the SDK is
// uninstalled (posthog-node removed from server/package.json)
// and the class is a no-op shell that preserves the public
// API every call-site uses. The 22 in-tree files that
// `Telemetry.sendTelemetry(...)` are intentionally NOT edited
// — keeping the call sites means future refactors that touch
// those files don't have to know about §E. The shell makes
// every call return immediately without doing anything.
//
// Rationale: defence-in-depth. DISABLE_TELEMETRY=true is an
// env-var gate; a single misconfigured .env could re-enable
// analytics. With the SDK uninstalled and the shell being a
// no-op, no analytics code exists to run regardless of env.

const Telemetry = {
  // Public API — every method is a no-op. Async signatures
  // preserved so the existing `await Telemetry.send...` call
  // sites don't need editing.
  sendTelemetry: async function () { return; },
  flush: async function () { return; },
  isDev: function () { return false; },
  client: function () { return null; },
  runtime: function () {
    if (process.env.ANYTHING_LLM_RUNTIME === "docker") return "docker";
    if (process.env.NODE_ENV === "production") return "production";
    return "other";
  },
  id: async function () { return null; },
  setUid: async function () { return null; },
  findOrCreateId: async function () { return null; },
  isOnCooldown: function () { return false; },
  markOnCooldown: function () { return; },
  connect: async function () { return { client: null, distinctId: null }; },
};

module.exports = { Telemetry };
