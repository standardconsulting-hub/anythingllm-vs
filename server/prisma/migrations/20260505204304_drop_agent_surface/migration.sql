-- Plan 2.5 §D — drop the workspace_agent_invocations table.
-- The agent surface (utils/agents, utils/agentFlows, utils/MCP,
-- the websocket handler, agent endpoints, frontend admin UI)
-- is removed; the table is no longer referenced. Row-count
-- guard at apply time confirmed 0 rows.
DROP TABLE IF EXISTS "workspace_agent_invocations";
