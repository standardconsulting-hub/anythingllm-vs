const { v4: uuidv4 } = require("uuid");
const { reqBody, userFromSession, multiUserMode } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { Telemetry } = require("../models/telemetry");
const { streamChatWithWorkspace } = require("../utils/chats/stream");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { EventLogs } = require("../models/eventLogs");
const {
  validWorkspaceAndThreadSlug,
  validWorkspaceSlug,
} = require("../utils/middleware/validWorkspace");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
// vs-fork Plan 1 Task 10: route the SSE stream through a buffer so
// no token reaches the user before the audit JSONL row is fsynced.
const { BufferingResponse } = require("../utils/audit/bufferingResponse");
const {
  AuditFailure,
  PersistFailure,
  FailClosedActive,
} = require("../utils/audit/audit-middleware");
const { WorkspaceThread } = require("../models/workspaceThread");
const { User } = require("../models/user");
const truncate = require("truncate");
const { getModelTag } = require("./utils");

function chatEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/stream-chat",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { message, attachments = [] } = reqBody(request);
        const workspace = response.locals.workspace;

        if (typeof message !== "string" || message.trim().length === 0) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: "Message is empty.",
          });
          return;
        }

        if (multiUserMode(response) && !(await User.canSendChat(user))) {
          response.status(429).json({
            id: uuidv4(),
            type: "abort",
            error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
          });
          return;
        }

        // vs-fork Plan 1 Task 10: stream into the buffer; flush
        // to the real response only after auditAndPersist commits
        // the audit JSONL row.
        const bufRes = new BufferingResponse();
        bufRes.setHeader("Cache-Control", "no-cache");
        bufRes.setHeader("Content-Type", "text/event-stream");
        bufRes.setHeader("Access-Control-Allow-Origin", "*");
        bufRes.setHeader("Connection", "keep-alive");
        bufRes.flushHeaders();

        try {
          await streamChatWithWorkspace(
            bufRes,
            workspace,
            message,
            workspace?.chatMode,
            user,
            null,
            attachments
          );
        } catch (auditErr) {
          if (
            auditErr instanceof AuditFailure ||
            auditErr instanceof PersistFailure ||
            auditErr instanceof FailClosedActive
          ) {
            response.status(auditErr.status || 503).json({
              error: auditErr.message,
              audit_state:
                auditErr instanceof FailClosedActive
                  ? "fail_closed"
                  : auditErr.name,
            });
            return;
          }
          throw auditErr;
        }

        await Telemetry.sendTelemetry("sent_chat", {
          multiUserMode: multiUserMode(response),
          LLMSelection: process.env.LLM_PROVIDER || "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          multiModal: Array.isArray(attachments) && attachments?.length !== 0,
          TTSSelection: process.env.TTS_PROVIDER || "native",
          LLMModel: getModelTag(),
        });

        await EventLogs.logEvent(
          "sent_chat",
          {
            workspaceName: workspace?.name,
            chatModel: workspace?.chatModel || "System Default",
          },
          user?.id
        );
        bufRes.flushTo(response);
      } catch (e) {
        console.error(e);
        if (!response.headersSent) {
          response.status(500).json({
            id: uuidv4(),
            type: "abort",
            error: e.message,
          });
          return;
        }
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/stream-chat",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { message, attachments = [] } = reqBody(request);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;

        if (typeof message !== "string" || message.trim().length === 0) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: "Message is empty.",
          });
          return;
        }

        if (multiUserMode(response) && !(await User.canSendChat(user))) {
          response.status(429).json({
            id: uuidv4(),
            type: "abort",
            error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
          });
          return;
        }

        // vs-fork Plan 1 Task 10: see /workspace/:slug/stream-chat
        // above for the rationale. Same buffer-then-flush pattern.
        const bufRes = new BufferingResponse();
        bufRes.setHeader("Cache-Control", "no-cache");
        bufRes.setHeader("Content-Type", "text/event-stream");
        bufRes.setHeader("Access-Control-Allow-Origin", "*");
        bufRes.setHeader("Connection", "keep-alive");
        bufRes.flushHeaders();

        try {
          await streamChatWithWorkspace(
            bufRes,
            workspace,
            message,
            workspace?.chatMode,
            user,
            thread,
            attachments
          );
        } catch (auditErr) {
          if (
            auditErr instanceof AuditFailure ||
            auditErr instanceof PersistFailure ||
            auditErr instanceof FailClosedActive
          ) {
            response.status(auditErr.status || 503).json({
              error: auditErr.message,
              audit_state:
                auditErr instanceof FailClosedActive
                  ? "fail_closed"
                  : auditErr.name,
            });
            return;
          }
          throw auditErr;
        }

        // If thread was renamed emit event to frontend via special `action` response.
        // Captured into the buffer; replayed onto the wire by flushTo.
        await WorkspaceThread.autoRenameThread({
          thread,
          workspace,
          user,
          newName: truncate(message, 22),
          onRename: (thread) => {
            writeResponseChunk(bufRes, {
              action: "rename_thread",
              thread: {
                slug: thread.slug,
                name: thread.name,
              },
            });
          },
        });

        await Telemetry.sendTelemetry("sent_chat", {
          multiUserMode: multiUserMode(response),
          LLMSelection: process.env.LLM_PROVIDER || "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          multiModal: Array.isArray(attachments) && attachments?.length !== 0,
          TTSSelection: process.env.TTS_PROVIDER || "native",
          LLMModel: getModelTag(),
        });

        await EventLogs.logEvent(
          "sent_chat",
          {
            workspaceName: workspace.name,
            thread: thread.name,
            chatModel: workspace?.chatModel || "System Default",
          },
          user?.id
        );
        bufRes.flushTo(response);
      } catch (e) {
        console.error(e);
        if (!response.headersSent) {
          response.status(500).json({
            id: uuidv4(),
            type: "abort",
            error: e.message,
          });
          return;
        }
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );
}

module.exports = { chatEndpoints };
