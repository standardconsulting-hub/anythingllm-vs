#!/usr/bin/env node
// vs-fork: Plan 1.5 v1.2.1 Task 9.
//
// Total-lockout recovery. The operator with shell access on the
// box runs:
//
//     node server/scripts/disable-mfa.js <user-id>
//
// Effects (after interactive `Type DELETE to confirm`):
//   - users.totp_secret_ciphertext        -> NULL
//   - users.totp_verified_at              -> NULL
//   - users.totp_last_used_counter        -> NULL
//   - users.mfa_failed_attempt_count      -> 0
//   - users.mfa_failed_window_start       -> NULL
//   - users.mfa_lockout_until             -> NULL
//   - users.must_rotate_password          -> true
//   - user_backup_codes (for that user)   -> deleted
//   - user_sessions (for that user)       -> revoked (reason="disable_mfa_recovery")
//   - audit row appended to recovery.log  -> append-only line
//
// The next login forces re-enrolment AND a password rotation,
// satisfying spec §4.4's requirement that out-of-band MFA
// recovery is paired with credential reset.
//
// Recovery-log path is configurable via VS_RECOVERY_LOG_PATH so
// the test harness can target a tmpdir; production default is
// /Vault/governance/audit/recovery.log (uappnd, see vs-fork-MFA.md).

require("dotenv").config();
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const prisma = require("../utils/prisma");
const { UserBackupCode } = require("../models/userBackupCode");
const { UserSession } = require("../models/userSession");

const DEFAULT_LOG_PATH = "/Vault/governance/audit/recovery.log";

function recoveryLogPath() {
  return process.env.VS_RECOVERY_LOG_PATH || DEFAULT_LOG_PATH;
}

function appendRecoveryEvent(event) {
  const logPath = recoveryLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, JSON.stringify(event) + "\n", { mode: 0o600 });
}

async function promptDelete() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) =>
    rl.question("Type DELETE to confirm: ", resolve)
  );
  rl.close();
  return answer === "DELETE";
}

async function disableMfa(userId, { confirmed = false } = {}) {
  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`no user with id ${userId}`);
    return { ok: false, code: 2 };
  }

  console.log(
    `About to disable MFA for: id=${user.id} username=${user.username}`
  );
  console.log(
    "Effects: wipes totp_secret + backup codes; revokes all sessions;"
  );
  console.log("         forces password rotation on next login.");

  const proceed = confirmed ? true : await promptDelete();
  if (!proceed) {
    console.error("aborted");
    return { ok: false, code: 1 };
  }

  // Direct prisma.users.update — User.update's `writable` filter
  // would silently strip these MFA columns.
  await prisma.users.update({
    where: { id: user.id },
    data: {
      totp_secret_ciphertext: null,
      totp_verified_at: null,
      totp_last_used_counter: null,
      mfa_failed_attempt_count: 0,
      mfa_failed_window_start: null,
      mfa_lockout_until: null,
      must_rotate_password: true,
    },
  });
  await UserBackupCode.wipe(user.id);
  const revoked = await UserSession.revokeAllForUser(
    user.id,
    "disable_mfa_recovery"
  );

  appendRecoveryEvent({
    type: "mfa_disabled_via_recovery_script",
    user_id: user.id,
    username: user.username,
    actor_uid: process.getuid(),
    revoked_sessions: revoked,
    at: new Date().toISOString(),
  });

  console.log(
    `MFA disabled. ${revoked} sessions revoked. Recovery event logged.`
  );
  return { ok: true, code: 0, revoked };
}

async function main() {
  const userId = parseInt(process.argv[2], 10);
  if (!userId) {
    console.error("usage: disable-mfa.js <user-id>");
    process.exit(2);
  }
  // VS_RECOVERY_AUTOCONFIRM=1 short-circuits the readline prompt
  // for non-interactive use (test harness, run-books). It is
  // explicitly NOT documented in the operator runbook because
  // the interactive prompt is part of the safety contract.
  const confirmed = process.env.VS_RECOVERY_AUTOCONFIRM === "1";
  const { code } = await disableMfa(userId, { confirmed });
  await prisma.$disconnect();
  process.exit(code);
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    try {
      await prisma.$disconnect();
    } catch {
      /* swallow */
    }
    process.exit(1);
  });
}

module.exports = { disableMfa, recoveryLogPath };
