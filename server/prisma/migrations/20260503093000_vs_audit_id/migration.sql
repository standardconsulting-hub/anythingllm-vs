-- vs-fork Plan 1 Task 8 — audit_id column on workspace_chats.
-- Nullable + uniquely indexed. Audit middleware writes the same
-- opaque id into the JSONL audit row and the SQLite turn so
-- history/export endpoints can filter by id presence rather
-- than timestamp matching.
ALTER TABLE "workspace_chats" ADD COLUMN "audit_id" TEXT;
CREATE UNIQUE INDEX "workspace_chats_audit_id_key" ON "workspace_chats"("audit_id");
CREATE INDEX "workspace_chats_audit_id_idx" ON "workspace_chats"("audit_id");
