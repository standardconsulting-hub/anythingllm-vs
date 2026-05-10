-- vs-fork Plan 4 §C.4a — per-workspace opt-in to cross-workspace
-- retrieval against the firm-reference workspace. Plan 4 §C.5
-- requires both this column AND the Workspace.writable allowlist
-- entry; without the writable entry, Workspace.update silently
-- drops the field on PATCH calls.
--
-- SQLite-safe: ADD COLUMN with no DEFAULT, no NOT NULL. Existing
-- rows get NULL on apply (the vanilla matter-only behaviour).
ALTER TABLE "workspaces" ADD COLUMN "cross_workspace_with" TEXT;
