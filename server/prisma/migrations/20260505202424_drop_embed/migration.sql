-- Plan 2.5 §B — drop embed widget tables.
-- The embed widget surface (handlers, models, frontend pages) is
-- removed; tables are no longer referenced by any code in the
-- fork. Row-count guard at apply time confirmed 0 rows in both
-- embed_chats and embed_configs.
DROP TABLE IF EXISTS "embed_chats";
DROP TABLE IF EXISTS "embed_configs";
