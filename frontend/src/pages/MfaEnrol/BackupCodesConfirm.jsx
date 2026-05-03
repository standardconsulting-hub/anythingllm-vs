// vs-fork Plan 1.5 frontend Task 7.
//
// Shows the 10 backup codes returned by /api/auth/mfa/enrol/confirm
// once. The "Continue" button is disabled until the operator
// explicitly confirms they've stored the codes — no skip path.
// On Continue, we route the operator BACK to /login so they can
// log in for real with their freshly-enrolled TOTP. Plan 1.5
// doesn't auto-mint a session JWT at /enrol/confirm, by design
// (one fewer high-value secret in flight).

import React, { useEffect, useMemo, useState } from "react";
import paths from "@/utils/paths";
import { MFA_CHALLENGE_TOKEN, MFA_USER_HINT } from "@/utils/constants";
import { BACKUP_CODES_STATE_KEY } from "./index.jsx";

export default function BackupCodesConfirm() {
  const [confirmed, setConfirmed] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const codes = useMemo(() => {
    try {
      const raw = window.sessionStorage.getItem(BACKUP_CODES_STATE_KEY);
      const parsed = JSON.parse(raw || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (codes.length === 0) {
      // No codes in this tab — operator probably refreshed past
      // the confirm step. Send them back to the start.
      window.location = paths.login();
    }
  }, [codes.length]);

  const handleContinue = () => {
    // Wipe every short-lived MFA artifact from sessionStorage —
    // backup codes have been displayed, the enrolment challenge
    // is consumed, the user hint can be re-derived at next login.
    window.sessionStorage.removeItem(BACKUP_CODES_STATE_KEY);
    window.sessionStorage.removeItem(MFA_CHALLENGE_TOKEN);
    window.sessionStorage.removeItem(MFA_USER_HINT);
    window.location = paths.login();
  };

  const handlePrint = () => window.print();

  if (codes.length === 0) return null;

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-theme-bg-primary text-white p-6 print:bg-white print:text-black">
      <div className="w-[640px] max-w-full flex flex-col gap-y-5 border border-white/20 rounded-xl p-8 bg-theme-bg-secondary print:border-0 print:bg-white">
        <header>
          <h1 className="text-2xl font-semibold">Save your backup codes</h1>
          <p className="text-sm text-white/70 mt-2 print:text-black/70">
            These ten codes can each be used <em>once</em> to sign in if
            you lose access to your authenticator app. They are
            <strong> shown only on this screen</strong>. Print this page
            or copy them into your physical safe — you will not be able
            to see them again.
          </p>
        </header>

        <div className="relative">
          <ol
            className={
              "grid grid-cols-2 gap-2 font-mono text-base bg-theme-bg-primary rounded-md p-4 print:bg-white print:text-black " +
              (revealed ? "" : "blur-sm select-none")
            }
          >
            {codes.map((c, i) => (
              <li key={i} className="flex">
                <span className="text-white/40 w-6 print:text-black/40">{i + 1}.</span>
                <span>{c}</span>
              </li>
            ))}
          </ol>
          {!revealed && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="absolute inset-0 flex items-center justify-center text-sm font-semibold underline print:hidden"
            >
              Click to reveal codes
            </button>
          )}
        </div>

        <div className="flex flex-row gap-3 print:hidden">
          <button
            type="button"
            onClick={handlePrint}
            className="border border-white/20 rounded-lg px-4 h-10 text-sm hover:bg-white/10"
          >
            Print
          </button>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(codes.join("\n"));
            }}
            className="border border-white/20 rounded-lg px-4 h-10 text-sm hover:bg-white/10"
          >
            Copy to clipboard
          </button>
        </div>

        <label className="flex items-start gap-2 text-sm text-white/80 print:hidden">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1"
          />
          <span>
            I have printed or stored these backup codes in a secure
            location. I understand I will not be able to see them again
            and will need them if I lose my authenticator device.
          </span>
        </label>

        <button
          type="button"
          disabled={!confirmed}
          onClick={handleContinue}
          className="bg-white text-zinc-950 hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold rounded-lg h-10 print:hidden"
        >
          Continue to login
        </button>
      </div>
    </div>
  );
}
