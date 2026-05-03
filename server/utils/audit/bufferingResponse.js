// vs-fork audit middleware — Plan 1 v5 Task 10 helper.
//
// Streaming audit guarantee: no token reaches the user before the
// audit JSONL line is fsynced. AnythingLLM's existing streaming
// path writes SSE chunks straight to the Express response as the
// LLM emits them; we need to keep the same call shape but capture
// the chunks instead of delivering them. After the LLM completes
// and the audit middleware fsyncs the row, the route handler
// flushes the captured chunks onto the real response in one go.
//
// Trade-off (documented in vs-fork-AUDIT.md): token-by-token
// streaming UX becomes batch-after-audit. Operator sees the full
// answer at once instead of word-by-word. Deliberate; do not
// "fix" without re-architecting the audit guarantee.

class BufferingResponse {
  constructor() {
    this.chunks = [];
    this.headers = {};
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    // Some upstream provider code wires an abort listener via
    // `response.on("close", ...)` (and matching `req.on(...)`),
    // expecting the response/request to be an EventEmitter. We
    // expose noop shims so attaching a listener doesn't blow up.
    // The audit-pause path doesn't honour the user's abort anyway
    // — the LLM keeps producing into the buffer until done.
    this.req = {
      on() {},
      once() {},
      off() {},
      addListener() {},
      removeListener() {},
      removeAllListeners() {},
    };
  }

  // EventEmitter-shape shims directly on the response, mirroring
  // the .req shims above. Required for upstream provider code
  // that calls `response.on("close", ...)` to register an abort
  // listener.
  on() {
    return this;
  }
  once() {
    return this;
  }
  off() {
    return this;
  }
  addListener() {
    return this;
  }
  removeListener() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
  emit() {
    return false;
  }

  setHeader(key, value) {
    this.headers[String(key)] = value;
  }

  getHeader(key) {
    return this.headers[String(key)];
  }

  flushHeaders() {
    // The real flush is deferred until flushTo() commits to the
    // wire. We mark headersSent so any code that checks the flag
    // sees a consistent state.
    this.headersSent = true;
  }

  writeHead(status, headersOrReason, headers) {
    this.statusCode = status;
    if (headersOrReason && typeof headersOrReason === "object") {
      Object.assign(this.headers, headersOrReason);
    } else if (headers && typeof headers === "object") {
      Object.assign(this.headers, headers);
    }
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  write(chunk) {
    if (this.writableEnded) return false;
    this.chunks.push(chunk);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
  }

  // Convenience for code that does response.json(body). Capture
  // it as a single chunk so flushTo can round-trip it.
  json(body) {
    this.headers["Content-Type"] =
      this.headers["Content-Type"] || "application/json";
    const buf = Buffer.from(JSON.stringify(body));
    this.write(buf);
    this.end();
    return this;
  }

  // Replay everything we captured onto the real Express response.
  // Headers go first (only if the real response hasn't already
  // committed them), then chunks in order, then end.
  flushTo(realResponse) {
    if (!realResponse.headersSent) {
      for (const [k, v] of Object.entries(this.headers)) {
        try {
          realResponse.setHeader(k, v);
        } catch {
          /* swallow — header may be reserved post-send */
        }
      }
      if (this.statusCode && this.statusCode !== 200) {
        realResponse.status(this.statusCode);
      }
      if (typeof realResponse.flushHeaders === "function") {
        realResponse.flushHeaders();
      }
    }
    for (const c of this.chunks) {
      realResponse.write(c);
    }
    realResponse.end();
  }
}

module.exports = { BufferingResponse };
