// BufferingResponse contract — Plan 1 Task 10.

const { BufferingResponse } = require("../bufferingResponse");

function fakeRealResponse() {
  return {
    headersSent: false,
    headers: {},
    statusCode: 200,
    chunks: [],
    setHeader(k, v) {
      this.headers[k] = v;
    },
    flushHeaders: jest.fn(function () {
      this.headersSent = true;
    }),
    status(c) {
      this.statusCode = c;
      return this;
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

describe("BufferingResponse", () => {
  it("captures writes and replays them in order on flushTo", () => {
    const buf = new BufferingResponse();
    buf.setHeader("Content-Type", "text/event-stream");
    buf.flushHeaders();
    buf.write("data: a\n\n");
    buf.write("data: b\n\n");
    buf.end();

    const real = fakeRealResponse();
    buf.flushTo(real);
    expect(real.chunks).toEqual(["data: a\n\n", "data: b\n\n"]);
    expect(real.headers["Content-Type"]).toBe("text/event-stream");
    expect(real.flushHeaders).toHaveBeenCalledTimes(1);
    expect(real.ended).toBe(true);
  });

  it("does not touch the real response if no flushTo is called", () => {
    const buf = new BufferingResponse();
    buf.write("never delivered");
    const real = fakeRealResponse();
    expect(real.chunks).toEqual([]);
  });

  it("flushTo skips header setting when real response has already committed", () => {
    const buf = new BufferingResponse();
    buf.setHeader("X-Set-By-Buf", "yes");
    buf.write("payload");
    const real = fakeRealResponse();
    real.headersSent = true; // simulate already-flushed real response
    buf.flushTo(real);
    expect(real.headers["X-Set-By-Buf"]).toBeUndefined();
    expect(real.chunks).toEqual(["payload"]);
    expect(real.flushHeaders).not.toHaveBeenCalled();
  });

  it("captures status from .status(c) and replays it when non-200", () => {
    const buf = new BufferingResponse();
    buf.status(503).write("oops");
    const real = fakeRealResponse();
    buf.flushTo(real);
    expect(real.statusCode).toBe(503);
  });

  it(".json captures body and ends", () => {
    const buf = new BufferingResponse();
    buf.json({ ok: true });
    expect(buf.writableEnded).toBe(true);
    const real = fakeRealResponse();
    buf.flushTo(real);
    expect(real.chunks.length).toBe(1);
    expect(JSON.parse(real.chunks[0].toString())).toEqual({ ok: true });
  });

  it("write after end is a no-op (matches stream semantics)", () => {
    const buf = new BufferingResponse();
    buf.write("first");
    buf.end();
    buf.write("after-end");
    const real = fakeRealResponse();
    buf.flushTo(real);
    expect(real.chunks).toEqual(["first"]);
  });

  it("req exposes a noop event-emitter shim so abort listeners don't crash", () => {
    const buf = new BufferingResponse();
    expect(() => buf.req.on("close", () => {})).not.toThrow();
    expect(() => buf.req.removeListener("close", () => {})).not.toThrow();
  });

  it("response itself is EventEmitter-shaped (.on / .off / .emit do not throw)", () => {
    // Upstream provider code calls response.on("close", handler)
    // to register abort listeners. Without these shims the
    // BufferingResponse threw "response.on is not a function".
    const buf = new BufferingResponse();
    expect(() => buf.on("close", () => {})).not.toThrow();
    expect(() => buf.once("close", () => {})).not.toThrow();
    expect(() => buf.off("close", () => {})).not.toThrow();
    expect(() => buf.removeListener("close", () => {})).not.toThrow();
    expect(buf.emit("close")).toBe(false);
  });
});
