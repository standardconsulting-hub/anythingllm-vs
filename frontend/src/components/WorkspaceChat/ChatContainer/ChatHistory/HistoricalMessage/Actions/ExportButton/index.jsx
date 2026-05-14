// vs-fork Plan 4 §G.3 — Export an assistant message's chat
// exchange to a markdown file under /Vault/Matters/<id>/outputs/.
//
// The button POSTs to /api/workspace/<slug>/export-chat/<chatId>;
// the server shells out to scripts/vs-export-output. Auth is
// the session JWT (validatedRequest + flexUserRoleValid).
//
// Rendered only on assistant messages with a chatId. Three
// visible states: idle, in-flight (spinner), done (check). The
// done state holds for ~2s then reverts so the operator can
// re-export if needed.
import React, { useState } from "react";
import { Export, Check, CircleNotch } from "@phosphor-icons/react";
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const DONE_LINGER_MS = 2000;

export default function ExportButton({ chatId, slug, role }) {
  const [status, setStatus] = useState("idle");

  if (!chatId || role === "user") return null;

  const onClick = async () => {
    if (status === "loading") return;
    setStatus("loading");
    try {
      const res = await fetch(
        `${API_BASE}/workspace/${slug}/export-chat/${chatId}`,
        {
          method: "POST",
          headers: baseHeaders(),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("export-chat failed:", res.status, body);
        setStatus("idle");
        return;
      }
      setStatus("done");
      setTimeout(() => setStatus("idle"), DONE_LINGER_MS);
    } catch (e) {
      console.error("export-chat threw:", e);
      setStatus("idle");
    }
  };

  return (
    <div className="mt-3 relative">
      <button
        onClick={onClick}
        data-tooltip-id="export-assistant-text"
        data-tooltip-content="Export to /Vault"
        className="text-zinc-300 light:text-slate-500"
        aria-label="Export to /Vault"
        disabled={status === "loading"}
      >
        {status === "done" ? (
          <Check size={20} className="mb-1" />
        ) : status === "loading" ? (
          <CircleNotch size={20} className="mb-1 animate-spin" />
        ) : (
          <Export size={20} className="mb-1" />
        )}
      </button>
    </div>
  );
}
