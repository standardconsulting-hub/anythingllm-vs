#!/usr/bin/env node
// vs-fork: Plan 1.5 v1.2.1 Task 9.
//
// Lost-device recovery (the lighter variant). Use when the
// operator believes the TOTP secret + backup codes themselves
// are still safe (e.g. phone misplaced but never online,
// laptop returned by IT). Effect:
//
//     node server/scripts/revoke-user-sessions.js <user-id>
//
//   - user_sessions (for that user)  -> revoked (reason="lost_device")
//   - users.must_rotate_password     -> true
//
// MFA secret + backup codes are intentionally preserved so the
// operator can still complete the next-login challenge. The
// password rotation is mandatory because spec §4.4 pairs every
// recovery action with a credential reset (closes Codex v1.1
// FLAG #2). If the operator is unsure whether the device or the
// MFA secret itself is compromised, they should run disable-mfa
// instead.

require("dotenv").config();
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const prisma = require("../utils/prisma");
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

async function revokeUserSessions(userId, { confirmed = false } = {}) {
  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`no user with id ${userId}`);
    return { ok: false, code: 2 };
  }

  console.log(
    `About to revoke all sessions for: id=${user.id} username=${user.username}`
  );
  console.log("Effects: revokes every active session; forces password");
  console.log("         rotation on next login. MFA secret + backup");
  console.log("         codes are preserved.");

  const proceed = confirmed ? true : await promptDelete();
  if (!proceed) {
    console.error("aborted");
    return { ok: false, code: 1 };
  }

  const revoked = await UserSession.revokeAllForUser(user.id, "lost_device");
  await prisma.users.update({
    where: { id: user.id },
    data: { must_rotate_password: true },
  });

  appendRecoveryEvent({
    type: "sessions_revoked_via_recovery_script",
    user_id: user.id,
    username: user.username,
    actor_uid: process.getuid(),
    revoked_sessions: revoked,
    at: new Date().toISOString(),
  });

  console.log(
    `${revoked} sessions revoked. Password rotation forced. Recovery event logged.`
  );
  return { ok: true, code: 0, revoked };
}

async function main() {
  const userId = parseInt(process.argv[2], 10);
  if (!userId) {
    console.error("usage: revoke-user-sessions.js <user-id>");
    process.exit(2);
  }
  const confirmed = process.env.VS_RECOVERY_AUTOCONFIRM === "1";
  const { code } = await revokeUserSessions(userId, { confirmed });
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

module.exports = { revokeUserSessions, recoveryLogPath };
