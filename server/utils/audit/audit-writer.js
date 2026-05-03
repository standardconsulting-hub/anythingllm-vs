// vs-fork audit JSONL writer. Plan 1 v5 Task 7.
//
// Lowest layer of the audit chain: append a single JSON line to
// a UTC-day-stamped file under <auditDir>, fsync, return. Every
// resolved promise must imply the data is on stable storage.
//
// The contract this module guarantees:
//   - Files are named `queries-YYYY-MM-DD.jsonl`, day-stamped in
//     UTC from `entry.ts` (ISO string or anything Date() accepts).
//   - File is created with mode 0600 (owner-only). Survives
//     restrictive umasks because we pass the mode to open(2)
//     explicitly.
//   - The promise returned by write() does not resolve until:
//       (a) the JSON line + newline is appended,
//       (b) fsync(file) completed, and
//       (c) on first creation only, fsync(parentDir) completed
//           — otherwise on certain filesystems a crash between
//           the file write and the dirent commit can lose the
//           file even though fsync(file) succeeded.
//   - Concurrent write() calls are serialised internally so
//     two interleaved JSON.stringify() outputs never produce a
//     malformed line.
//
// Spec ref: VS Declaration v1.3 §6.1.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function dayStampUtc(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function makeAuditWriter({ auditDir }) {
  // In-process serialisation queue. The writer lives for the
  // lifetime of the server process; concurrent writes chain
  // through this lock. fs.open(..., "a") gives us O_APPEND so
  // the kernel guarantees atomicity for writes ≤ PIPE_BUF
  // (typically 4 KiB on darwin/linux), but a Plan 1 audit row
  // can be much larger than that, so we serialise explicitly
  // rather than relying on O_APPEND alone.
  let chain = Promise.resolve();

  function writeOne(entry) {
    return chain.then(async () => {
      const date = new Date(entry.ts);
      if (Number.isNaN(date.getTime())) {
        throw new TypeError(
          `audit-writer: entry.ts is not a parseable date: ${entry.ts}`
        );
      }
      const filename = `queries-${dayStampUtc(date)}.jsonl`;
      const filepath = path.join(auditDir, filename);
      const isFirstWrite = !fs.existsSync(filepath);

      const fh = await fsp.open(filepath, "a", 0o600);
      try {
        await fh.write(JSON.stringify(entry) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }

      if (isFirstWrite) {
        const dirFh = await fsp.open(auditDir, "r");
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      }
    });
  }

  return {
    async write(entry) {
      // Capture the new tail of the chain so the next caller's
      // write awaits ours, and `chain` itself never accumulates
      // rejections (we return our own promise to the caller and
      // strip the failure from the shared chain).
      const next = writeOne(entry);
      chain = next.catch(() => {});
      return next;
    },
  };
}

module.exports = { makeAuditWriter };
