// vs-fork Plan 1.5 frontend Task 7.
//
// Shown after password login when /api/request-token returns
// `needs_totp: true`. Reads the single-use challenge_token from
// sessionStorage, takes a 6-digit TOTP code OR a backup code,
// and on success mints the full session JWT via
// POST /api/auth/mfa/challenge. On error, walks through the
// 401/429/400 surface so the operator knows whether to try
// again, wait, or use a backup code.

import React, { useEffect, useMemo, useState } from "react";
import System from "@/models/system";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import {
  AUTH_TOKEN,
  AUTH_USER,
  MFA_CHALLENGE_TOKEN,
  MFA_USER_HINT,
} from "@/utils/constants";

export default function MfaChallenge() {
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const challengeToken = useMemo(
    () => window.sessionStorage.getItem(MFA_CHALLENGE_TOKEN),
    []
  );
  const userHint = useMemo(() => {
    try {
      return JSON.parse(window.sessionStorage.getItem(MFA_USER_HINT) || "null");
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!challengeToken) {
      // No challenge token in this tab — operator probably refreshed
      // or hit the URL directly. Send them back to /login.
      window.location = paths.login();
    }
  }, [challengeToken]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = await System.mfa.challenge(
      challengeToken,
      code.trim(),
      useBackupCode
    );
    setLoading(false);

    if (result?.session_token) {
      window.localStorage.setItem(AUTH_TOKEN, result.session_token);
      if (userHint) window.localStorage.setItem(AUTH_USER, JSON.stringify(userHint));
      window.sessionStorage.removeItem(MFA_CHALLENGE_TOKEN);
      window.sessionStorage.removeItem(MFA_USER_HINT);
      window.location = paths.home();
      return;
    }

    if (result?.status === 429) {
      setError(
        "Too many invalid attempts. Your account is temporarily locked. Try again later or use a backup code."
      );
      return;
    }

    if (result?.error === "challenge_token_invalid") {
      setError(
        "This challenge has expired or already been used. Returning to login."
      );
      window.sessionStorage.removeItem(MFA_CHALLENGE_TOKEN);
      window.sessionStorage.removeItem(MFA_USER_HINT);
      setTimeout(() => (window.location = paths.login()), 1200);
      return;
    }

    if (result?.reason === "replay") {
      setError(
        "That code was already used. Wait for a fresh code from your authenticator."
      );
      return;
    }

    setError(
      useBackupCode
        ? "Invalid backup code. Backup codes are single-use; check you typed the right one."
        : "Invalid code. Check the time on your authenticator and try again."
    );
  };

  if (!challengeToken) return null;

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-theme-bg-primary text-white">
      <form
        onSubmit={handleSubmit}
        className="w-[420px] flex flex-col gap-y-5 border border-white/20 rounded-xl p-8 bg-theme-bg-secondary"
      >
        <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
        {userHint?.username && (
          <p className="text-sm text-white/60">
            Signed in as <span className="font-mono">{userHint.username}</span>.
            Type the {useBackupCode ? "backup code" : "6-digit code"} from your
            authenticator app to finish logging in.
          </p>
        )}

        <input
          autoFocus
          inputMode={useBackupCode ? "text" : "numeric"}
          pattern={useBackupCode ? undefined : "\\d{6}"}
          maxLength={useBackupCode ? 32 : 6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={useBackupCode ? "backup code" : "123456"}
          className="bg-theme-bg-primary border border-white/20 rounded-lg px-3 py-2 text-lg font-mono tracking-wider"
        />

        {error && (
          <div className="text-sm text-red-400 border border-red-400/50 bg-red-400/10 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !code.trim()}
          className="bg-white text-zinc-950 hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold rounded-lg h-10"
        >
          {loading ? "Verifying…" : "Verify"}
        </button>

        <button
          type="button"
          onClick={() => {
            setCode("");
            setError(null);
            setUseBackupCode((v) => !v);
          }}
          className="text-xs text-white/60 hover:text-white"
        >
          {useBackupCode
            ? "Use a 6-digit code from your authenticator instead"
            : "Use a backup code instead"}
        </button>

        <a
          href={paths.login()}
          className="text-xs text-white/40 hover:text-white text-center"
        >
          Cancel and return to sign-in
        </a>
      </form>
    </div>
  );
}
