// vs-fork Plan 4 §E.2 commit 5: CitationWarning banner.
//
// Renders ABOVE the assistant's message body when the audit
// middleware's shape-only post-check returned ok=false. The
// post-check is documented in spec §5.4 — substantive citation
// verification stays the fee-earner's responsibility; this
// banner only signals that the LLM produced factual-style
// sentences without inline citations.
//
// Mounted from BOTH HistoricalMessage (post-stream + replays +
// history loads) and PromptReply (active stream) so the banner
// shows on every render path the assistant's reply touches.
//
// Path note (delta from the §E.2 plan v7): the directory is
// ChatHistory/CitationWarning, NOT ChatMessage/CitationWarning
// — there is no ChatMessage/ subtree on this fork. Documented
// in runtime/anythingllm-fork/E2-WIRING-SEQUENCE.md.

import { Warning } from "@phosphor-icons/react";

const REASON_COPY = {
  flagged:
    "The model produced factual-style sentences without inline citations. Review the flagged passages before relying on them.",
  timeout:
    "The citation post-check did not finish in time. Treat this turn as un-checked.",
  script_error:
    "The citation post-check exited with an error. Treat this turn as un-checked.",
  invalid_output:
    "The citation post-check produced output the audit layer could not parse. Treat this turn as un-checked.",
  spawn_error:
    "The citation post-check could not start. Treat this turn as un-checked.",
  no_script:
    "Citation post-check is not configured on this server. Treat this turn as un-checked.",
};

function reasonCopy(reason) {
  return (
    REASON_COPY[reason] ||
    "The citation post-check flagged an issue with this turn."
  );
}

const FLAGGED_PREVIEW_LIMIT = 3;

const CitationWarning = ({ citation_check }) => {
  // Defensive: render nothing for legacy rows (no field) and
  // for clean turns. Object.freeze sentinels (ok: true,
  // reason: "no_llm_completion") also pass through silently.
  if (!citation_check || citation_check.ok !== false) return null;

  const reason = citation_check.reason || "flagged";
  const flagged = Array.isArray(citation_check.flagged_sentences)
    ? citation_check.flagged_sentences
    : [];
  const previewed = flagged.slice(0, FLAGGED_PREVIEW_LIMIT);
  const remainder = flagged.length - previewed.length;

  return (
    <div
      data-testid="citation-warning"
      data-reason={reason}
      className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900"
    >
      <div className="flex items-start gap-2">
        <Warning
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700"
          aria-hidden="true"
        />
        <div className="text-sm">
          <p className="font-semibold">Citation post-check: {reason}</p>
          <p className="mt-0.5">{reasonCopy(reason)}</p>
          {previewed.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs">
              {previewed.map((s, i) => (
                <li key={i} className="break-words">
                  {s}
                </li>
              ))}
              {remainder > 0 && (
                <li className="italic">
                  {remainder} further sentence{remainder === 1 ? "" : "s"}{" "}
                  flagged.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default CitationWarning;
