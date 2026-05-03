// vs-fork Plan 1.5 frontend Task 7.
//
// First-run / total-recovery enrolment screen. Reads the
// mfa-enrolment challenge_token stashed by either:
//   - UserSetup (first-run setup), or
//   - MultiUserAuth (existing user with no totp_verified_at — e.g.
//     after disable-mfa.js).
//
// Calls POST /api/auth/mfa/enrol → server returns the otpauth_url
// (for the QR), the QR data URL, and a refreshed challenge_token.
// Operator scans, types a 6-digit code, we POST /enrol/confirm,
// then route to /login/mfa-backup-codes carrying the 10 codes.

import React, { useEffect, useMemo, useState } from "react";
import System from "@/models/system";
import paths from "@/utils/paths";
import {
  MFA_CHALLENGE_TOKEN,
  MFA_USER_HINT,
} from "@/utils/constants";

const BACKUP_CODES_STATE_KEY = "anythingllm_mfaBackupCodesPayload";

export default function MfaEnrol() {
  const [enrolment, setEnrolment] = useState(null); // { otpauth_url, qr_data_url, challenge_token }
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  const userHint = useMemo(() => {
    try {
      return JSON.parse(window.sessionStorage.getItem(MFA_USER_HINT) || "null");
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const challenge = window.sessionStorage.getItem(MFA_CHALLENGE_TOKEN);
    if (!challenge) {
      window.location = paths.login();
      return;
    }
    setLoading(true);
    System.mfa.enrol(challenge).then((res) => {
      setLoading(false);
      if (res?.error) {
        setError(
          "Could not start enrolment: " +
            (res.error === "challenge_token_invalid"
              ? "the challenge expired or was already used. Returning to login."
              : res.error)
        );
        if (res.error === "challenge_token_invalid") {
          window.sessionStorage.removeItem(MFA_CHALLENGE_TOKEN);
          setTimeout(() => (window.location = paths.login()), 1500);
        }
        return;
      }
      // Server rotates the challenge_token on each step; replace.
      if (res.challenge_token)
        window.sessionStorage.setItem(MFA_CHALLENGE_TOKEN, res.challenge_token);
      setEnrolment(res);
    });
  }, []);

  const handleConfirm = async (e) => {
    e.preventDefault();
    setError(null);
    setConfirming(true);
    const challenge = window.sessionStorage.getItem(MFA_CHALLENGE_TOKEN);
    const result = await System.mfa.enrolConfirm(challenge, code.trim());
    setConfirming(false);
    if (result?.enrolled && Array.isArray(result.backup_codes)) {
      window.sessionStorage.setItem(
        BACKUP_CODES_STATE_KEY,
        JSON.stringify(result.backup_codes)
      );
      window.location = paths.loginMfaBackupCodes();
      return;
    }
    if (result?.error === "challenge_token_invalid") {
      setError(
        "This enrolment session expired. Returning to login to start over."
      );
      window.sessionStorage.removeItem(MFA_CHALLENGE_TOKEN);
      setTimeout(() => (window.location = paths.login()), 1500);
      return;
    }
    if (result?.reason === "replay") {
      setError(
        "That code was already used. Wait for the next 30-second window."
      );
      return;
    }
    setError(
      "Invalid code. Check the time on your authenticator and try again."
    );
  };

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-theme-bg-primary text-white p-6">
      <div className="w-[640px] max-w-full flex flex-col gap-y-6 border border-white/20 rounded-xl p-8 bg-theme-bg-secondary">
        <header className="flex flex-col gap-y-1">
          <h1 className="text-2xl font-semibold">Set up two-factor authentication</h1>
          <p className="text-sm text-white/60">
            VS Declaration requires TOTP MFA on every login (spec §4.4).
            Scan the QR code with an authenticator app
            (1Password, Authy, or Google Authenticator), then enter the
            6-digit code to finish enrolment.
            {userHint?.username && (
              <>
                {" "}
                Account: <span className="font-mono">{userHint.username}</span>.
              </>
            )}
          </p>
        </header>

        {loading && <p className="text-white/60">Generating QR…</p>}

        {enrolment && (
          <div className="flex flex-col md:flex-row gap-6">
            <div className="flex flex-col items-center gap-2">
              <img
                src={enrolment.qr_data_url}
                alt="MFA QR code"
                className="w-[220px] h-[220px] bg-white rounded-md"
              />
              <details className="text-xs text-white/60 mt-2 w-[220px]">
                <summary className="cursor-pointer">
                  Can't scan? Show secret
                </summary>
                <p className="font-mono break-all mt-2">
                  {enrolment.otpauth_url}
                </p>
              </details>
            </div>

            <form onSubmit={handleConfirm} className="flex-1 flex flex-col gap-y-4">
              <label className="text-sm text-white/80">
                Enter the 6-digit code your authenticator shows now:
              </label>
              <input
                autoFocus
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="bg-theme-bg-primary border border-white/20 rounded-lg px-3 py-2 text-lg font-mono tracking-wider"
              />
              {error && (
                <div className="text-sm text-red-400 border border-red-400/50 bg-red-400/10 rounded-md px-3 py-2">
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={confirming || code.length !== 6}
                className="bg-white text-zinc-950 hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold rounded-lg h-10"
              >
                {confirming ? "Confirming…" : "Confirm and continue"}
              </button>
            </form>
          </div>
        )}

        {error && !enrolment && (
          <div className="text-sm text-red-400 border border-red-400/50 bg-red-400/10 rounded-md px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export { BACKUP_CODES_STATE_KEY };
