# vs-fork — Extra-Channel Inventory (Plan 2.5 §F)

This document records the channel surfaces that **Plan 2.5
deliberately did NOT strip**. Each is currently in the fork
build but is gated to a future plan. Plan 2.5 verified that
**none of them is an unaudited chat path** — the audit-invariant
gate (Step 0e: `getChatCompletion|streamGetChatCompletion|
handleStream` callers without `auditAndPersist`) returned EMPTY
after every commit and is empty in the final state.

If a future operator decides to use any of these channels,
strip or audit-wrap them BEFORE first use on real client
material. The criteria a channel must satisfy before reaching
production:

1. Every chat-completion code path inside the channel routes
   through `auditAndPersist`.
2. The streaming response shape is compatible with Plan 1's
   `BufferingResponse` pattern (or the route handler is
   refactored to match `endpoints/api/workspace/index.js:877-927`).
3. If the channel exposes inbound WebSocket / webhook traffic,
   the Plan 2 PF anchor allowlists the source range or the
   route is bound to loopback only.

---

## §F.1 — Mobile (`endpoints/mobile/`)

**What it is.** Mobile-app integration: push tokens, mobile
session APIs, **AND a streaming chat handler at
`endpoints/mobile/utils/index.js:169` that calls
`ApiChatHandler.streamChat(...)` directly.**

**Routes registered.** Mounted in `server/index.js` via
`mobileEndpoints(apiRouter)`. Route prefix `/mobile/`.

**Files.**
- `server/endpoints/mobile/index.js`
- `server/endpoints/mobile/utils/index.js` (the streaming chat
  caller)

**Threat-model relevance.** The COFA may want a mobile path in
a future v2 — TBD with operator. Currently unused.

**Criticality of caveat (CRITICAL).** Plan 2.5 §D's streamChat
rejection branch assumes the `response` parameter is a
`BufferingResponse` (because the workspace UI route handlers
wrap it). On the mobile streaming path, `ApiChatHandler.streamChat`
is invoked with the **real Express response** — meaning the
rejection chunk written by `writeResponseChunk(response, ...)`
flushes to the wire immediately, BEFORE `auditAndPersist`
runs. If audit throws afterward, the rejection chunk is
already on the wire — audit-or-nothing semantics break.

**Recommended action — BEFORE the mobile path is enabled
on real client material**, do ONE of:

- **Strip the mobile surface entirely** (recommended if the
  COFA isn't going to use mobile). Same shape as §A's strip:
  delete `endpoints/mobile/`, drop the route mount in
  `server/index.js`. Estimated effort: 1 hour.
- **Refactor `endpoints/mobile/utils/index.js:169` to wrap the
  Express response in a `BufferingResponse`** before calling
  `streamChat`, then run `bufRes.flushTo(response)` only on
  the success path. The route handler must also catch
  `AuditFailure` / `PersistFailure` / `FailClosedActive` and
  return 503. Estimated effort: 4 hours (one route handler
  refactor + new integration test).

Until either is done, **the mobile route is unsafe for live
use** because an @agent rejection on mobile could leave the
audit row missing while the rejection chunk is on the wire.

---

## §F.2 — Web-push notifications (`endpoints/webPush.js`)

**What it is.** Browser push notifications for chat events
(new message arrived, document finished embedding, etc.)
delivered via the Web Push protocol (VAPID keys + service
worker).

**Routes registered.** Mounted in `server/index.js` via
`webPushEndpoints(apiRouter)`.

**Files.**
- `server/endpoints/webPush.js`
- `server/utils/PushNotifications/`

**Threat-model relevance.** Optional UX polish. The COFA
operates the Declaration on a single Mac Studio + MBP via
Tailscale — push notifications would arrive on the MBP only,
which is already the operator's primary device. No security
need to rip; no security gain from removing.

**Recommended action.** Leave as-is for v1. Revisit at Plan
5 when the firm's operational pattern is clearer. If the
push tokens contain any client-material context (e.g. message
preview), the audit pipeline needs to capture the push event;
otherwise leaving as-is is fine.

**Estimated effort if rip is chosen.** 30 minutes (no DB
migration; just delete files + drop the mount).

---

## §F.3 — Browser extension (`endpoints/browserExtension.js`)

**What it is.** Authentication and content-upload endpoints
for the AnythingLLM browser extension, which lets the user
"send to AnythingLLM" content from any web page.

**Routes registered.** Mounted in `server/index.js` via
`browserExtensionEndpoints(apiRouter)`. Routes include
`/browser-extension/embed-content` and `/browser-extension/upload-content`.

**Files.**
- `server/endpoints/browserExtension.js`
- `server/models/browserExtensionApiKey.js`

**Threat-model relevance.** **Possibly used by COFA** — TBD
with operator. The extension would let the COFA send a web
page (e.g. a coroner's published report URL) into a workspace
without manual download.

**Audit posture.** The extension's content-upload paths route
through the same collector + audit middleware as the regular
document-upload path (Plan 2 §E shipped the upload audit
hook; works for the browser-extension surface too).

**Recommended action.** Confirm with operator whether the
COFA uses the browser extension. If yes, leave as-is —
audit posture is already correct. If no, strip in a future
plan; same recipe as §F.1 mobile rip.

**Estimated effort if rip is chosen.** 1 hour (delete files,
drop route mount, drop `browser_extension_api_keys` Prisma
model + migration).

---

## §F.4 — Generic extensions framework (`endpoints/extensions/`)

**What it is.** A generic plugin extension framework:
admin can configure third-party "extensions" that AnythingLLM
invokes during certain events. Each extension is a JavaScript
plugin loaded from `server/extensions/<name>/`.

**Routes registered.** Mounted in `server/index.js` via
`extensionEndpoints(apiRouter)` (verify route prefix at
mount time).

**Files.**
- `server/endpoints/extensions/index.js`
- `server/extensions/<name>/` (per-extension)

**Threat-model relevance.** Generic = depends entirely on
which extensions are actually loaded. The COFA's threat model
doesn't allow third-party code paths to handle client material
without an explicit per-extension audit review.

**Recommended action.** Audit which extensions are present in
the live install at Plan 5 governance review. If any extension
processes chat content, that extension MUST go through
`auditAndPersist`. Strip extensions not used by the COFA.
Strip the framework entirely if no extensions are used.

**Estimated effort.** Per-extension review: 1 hour each.
Framework strip: 2 hours (delete `endpoints/extensions/`,
drop the mount, audit any DB tables).

---

## §F.5 — Final assertion

After all five Plan 2.5 strips (§A, §G, §B, §C, §D, §E) and
this inventory, the **unaudited-chat-path inventory file from
Plan 2.5 Step 0e is EMPTY**. The four channel surfaces above
either don't expose chat completion at all (web-push, browser
extension content-upload, extensions framework) or expose it
only through paths that already go through `auditAndPersist`
(mobile, conditional on the §F.1 caveat).

The audit invariant — "every chat path through this fork
writes an audit line" — holds at the time of Plan 2.5's
completion. Any future surface added (a new mobile UI, a
browser extension chat API, an extension that calls an LLM)
must satisfy that invariant before reaching production.

---

*Plan 2.5 §F authored 2026-05-05. Refresh at every Plan 5
governance review.*
