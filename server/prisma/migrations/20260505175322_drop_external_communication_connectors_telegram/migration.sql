-- Plan 2.5 §G — drop the external_communication_connectors table.
-- The table only ever held Telegram bot config; with the Telegram
-- surface stripped (see commit message), the table is dead.
-- Row-count guard at apply time confirmed 0 rows present.
DROP TABLE IF EXISTS "external_communication_connectors";
