-- vs-fork Plan 1 v5.1 final-Codex FLAG 9: the original
-- 20260503093000_vs_audit_id migration created both a UNIQUE
-- index (`workspace_chats_audit_id_key`) and a non-unique index
-- (`workspace_chats_audit_id_idx`) on the same column. The unique
-- index already satisfies every lookup the non-unique one would,
-- so the latter is dead weight and double the write cost on every
-- chat turn. Drop it.
DROP INDEX IF EXISTS "workspace_chats_audit_id_idx";
