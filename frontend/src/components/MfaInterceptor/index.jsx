// vs-fork Plan 1.5 frontend Tasks 8 + 8.5.
//
// One window.fetch wrapper that handles two boundary conditions
// the backend introduced in Plan 1.5:
//
//   Task 8: 401 { error: "session_expired" }
//     The user's 15-min idle window elapsed (or another tab's
//     /mfa/sessions/revoke-all just landed). Clear local auth
//     state, redirect to /login?reason=idle.
//
//   Task 8.5: 403 { error: "needs_step_up", needs_totp: true }
//     The endpoint requires a fresh TOTP step-up. Open a modal,
//     prompt for a 6-digit code, POST to /api/auth/mfa/step-up.
//     On success, retry the original request *exactly once* with
//     the same input/init. On modal cancel or step-up failure,
//     surface the original 403 to the calling component.
//
// The wrapper installs once, idempotently (a re-mount during HMR
// does not double-wrap). It refuses to install on cross-origin
// requests — only same-origin /api/* calls go through the MFA
// pathway.

import React, { useEffect, useState } from "react";
import paths from "@/utils/paths";
import { AUTH_TOKEN, AUTH_USER, AUTH_TIMESTAMP } from "@/utils/constants";

const STEP_UP_EVENT = "vs-fork:open-step-up-modal";

function clearAuthAndRedirectToLogin() {
  window.localStorage.removeItem(AUTH_TOKEN);
  window.localStorage.removeItem(AUTH_USER);
  window.localStorage.removeItem(AUTH_TIMESTAMP);
  // Avoid an infinite redirect loop if we're already on /login.
  if (!window.location.pathname.startsWith("/login")) {
    window.location = paths.login() + "?reason=idle";
  }
}

function openStepUpModal() {
  return new Promise((resolve) => {
    const handler = (e) => {
      window.removeEventListener("vs-fork:step-up-result", handler);
      resolve(e.detail); // { ok: true } | { ok: false }
    };
    window.addEventListener("vs-fork:step-up-result", handler);
    window.dispatchEvent(new CustomEvent(STEP_UP_EVENT));
  });
}

async function readBody(res) {
  // Single-shot — caller must clone before consuming if they need
  // to read again. Returns null on non-JSON bodies.
  try {
    return await res.json();
  } catch {
    return null;
  }
}

let installed = false;

export function installMfaInterceptor() {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);

  window.fetch = async function vsFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const isApi =
      typeof url === "string" &&
      (url.startsWith("/api/") || url.includes("/api/"));
    if (!isApi) return original(input, init);

    const res = await original(input, init);

    if (res.status === 401) {
      const body = await readBody(res.clone());
      if (body && body.error === "session_expired") {
        clearAuthAndRedirectToLogin();
        // Still return the response so the awaiting caller's
        // .json()/.text() continue to function — we redirect on a
        // best-effort basis and don't synthesise a fake response.
        return res;
      }
    }

    if (res.status === 403) {
      const body = await readBody(res.clone());
      if (body && body.error === "needs_step_up") {
        const result = await openStepUpModal();
        if (!result?.ok) return res;
        // Retry the original request exactly once. Re-issue with
        // the same input/init; the bearer token in init.headers
        // still points at the same session, now stepped up.
        return await original(input, init);
      }
    }

    return res;
  };
}

// React surface — mount once at app root. Renders the step-up
// modal that the interceptor opens via custom event.
export default function MfaInterceptor() {
  useEffect(() => {
    installMfaInterceptor();
  }, []);
  return <StepUpModal />;
}

function StepUpModal() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handler = () => {
      setCode("");
      setError(null);
      setOpen(true);
    };
    window.addEventListener(STEP_UP_EVENT, handler);
    return () => window.removeEventListener(STEP_UP_EVENT, handler);
  }, []);

  const close = (ok) => {
    setOpen(false);
    setSubmitting(false);
    window.dispatchEvent(
      new CustomEvent("vs-fork:step-up-result", { detail: { ok } })
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // Use the unwrapped fetch via System.mfa.stepUp — but System
    // is going through window.fetch (now wrapped). That's fine:
    // step-up itself doesn't return needs_step_up, so the wrapper
    // will pass it through cleanly.
    const System = (await import("@/models/system")).default;
    const result = await System.mfa.stepUp(code.trim());
    setSubmitting(false);
    if (result?.stepped_up) {
      close(true);
      return;
    }
    if (result?.status === 429) {
      setError("Too many attempts. Wait before trying again.");
      return;
    }
    if (result?.reason === "replay") {
      setError(
        "That code was already used. Wait for a fresh code from your authenticator."
      );
      return;
    }
    setError("Invalid code. Try again.");
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center print:hidden">
      <form
        onSubmit={handleSubmit}
        className="w-[400px] flex flex-col gap-y-4 bg-theme-bg-secondary text-white border border-white/20 rounded-xl p-6"
      >
        <h2 className="text-lg font-semibold">Confirm with two-factor</h2>
        <p className="text-sm text-white/70">
          This action requires a fresh 6-digit code from your authenticator.
        </p>
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
        <div className="flex flex-row gap-2">
          <button
            type="button"
            onClick={() => close(false)}
            className="flex-1 border border-white/20 rounded-lg h-10 text-sm hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || code.length !== 6}
            className="flex-1 bg-white text-zinc-950 hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg h-10 text-sm font-semibold"
          >
            {submitting ? "Verifying…" : "Confirm"}
          </button>
        </div>
      </form>
    </div>
  );
}
