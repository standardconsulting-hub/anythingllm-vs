import { useState } from "react";

// vs-fork Plan 4 §C — operator toggle for the
// firm-reference cross-workspace retrieval feature. Maps
// 1:1 to the workspaces.cross_workspace_with column added
// in migration 20260510132745_vs_workspace_cross_workspace_with.
// ON  → POSTs "firm-reference" (FIRM_REFERENCE_NAMESPACE
//       on the server side; see
//       server/utils/chats/firm-reference.js).
// OFF → POSTs "" which the workspace.cross_workspace_with
//       validation coerces to null at write time so the
//       helper short-circuits to zero-count on the next
//       chat.
//
// Default ON for fresh workspaces is intentional: the
// firm-reference workspace is the firm-wide pre-vetted
// SOP/precedent corpus, and the v1 product expectation is
// that matter workspaces blend it in. Operators can
// disable per-workspace for sensitive matters that must
// stay siloed.

const FIRM_REFERENCE_NAMESPACE = "firm-reference";

export default function CrossWorkspaceToggle({ workspace, setHasChanges }) {
  // workspace.cross_workspace_with is null on legacy rows
  // (pre-Plan-4-§C). Treat null as "default ON" only at
  // FIRST render — once the operator interacts the value
  // sticks. This matches the spec: opt-out, not opt-in.
  const initial =
    workspace?.cross_workspace_with === null ||
    workspace?.cross_workspace_with === undefined
      ? true
      : workspace.cross_workspace_with === FIRM_REFERENCE_NAMESPACE;
  const [enabled, setEnabled] = useState(initial);

  return (
    <div>
      <div className="flex flex-col">
        <label htmlFor="cross_workspace_with" className="block input-label">
          Use firm-reference workspace for retrieval
        </label>
      </div>
      <label className="relative inline-flex items-center mt-2 cursor-pointer">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setHasChanges(true);
          }}
        />
        <input
          type="hidden"
          name="cross_workspace_with"
          value={enabled ? FIRM_REFERENCE_NAMESPACE : ""}
        />
        <div className="peer h-6 w-11 rounded-full bg-[#CFCFD0] after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:shadow-xl after:border after:border-gray-600 after:bg-white after:box-shadow-md after:transition-all after:content-[''] peer-checked:bg-[#32D583] peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-[#32D583]"></div>
      </label>
      <p className="text-white text-opacity-60 text-xs font-medium py-1.5">
        When enabled, retrieval blends matter chunks with up to half the
        configured Max Context Snippets from the shared firm-reference workspace
        (SOPs, precedent, internal guidance). Disable to keep retrieval scoped
        to this matter only — required when the firm-reference corpus must not
        bleed into a sensitive matter.
      </p>
    </div>
  );
}
