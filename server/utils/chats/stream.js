const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
// vs-fork Plan 1 Task 10: frontend streaming chat audit. Caller
// must pass a BufferingResponse so chunks are captured until
// auditAndPersist fsyncs the JSONL row.
const {
  auditAndPersist,
  AuditFailure,
  PersistFailure,
  FailClosedActive,
} = require("../audit/audit-middleware");
// vs-fork Plan 4 §E.2 commit 4: same shape-only citation
// post-check pattern as apiChatHandler (commit 3) — full result
// onto the chat-row blob, boolean shape onto modelMeta for the
// audit row.
const { runCitationPostcheck } = require("../audit/citation-postcheck");
const REFUSAL_CITATION_CHECK = Object.freeze({
  ok: true,
  flagged_sentences: [],
  reason: "no_llm_completion",
});
// vs-fork Plan 4 §C.4e: same cross-workspace helper as
// apiChatHandler imports — used at the LLM-completion site
// post-vector-merge.
const {
  fetchFirmReferenceChunks,
  FIRM_REFERENCE_NAMESPACE,
} = require("./firm-reference");
// vs-fork Plan 2.5 §D: agent surface stripped. grepAgents is
// gone; isAgentRequest detects @agent-prefixed messages so
// streamChatWithWorkspace can audit and reject them.
const { isAgentRequest } = require("./apiChatHandler");
const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  recentChatHistory,
  sourceIdentifier,
} = require("./index");

const VALID_CHAT_MODE = ["automatic", "chat", "query"];

async function streamChatWithWorkspace(
  response,
  workspace,
  message,
  chatMode = "automatic",
  user = null,
  thread = null,
  attachments = []
) {
  const uuid = uuidv4();
  const updatedMessage = await grepCommand(message, user);

  if (Object.keys(VALID_COMMANDS).includes(updatedMessage)) {
    const data = await VALID_COMMANDS[updatedMessage](
      workspace,
      message,
      uuid,
      user,
      thread
    );
    writeResponseChunk(response, data);
    return;
  }

  // vs-fork Plan 2.5 §D: agent mode is disabled. The web stream
  // routes (endpoints/chat.js — `POST /api/workspace/:slug/stream-chat`
  // and the thread variant) wrap `response` in a BufferingResponse
  // before calling streamChatWithWorkspace; chunks accumulate in
  // memory and the route handler runs flushTo() on success. If
  // audit throws below, the route handler's AuditFailure catch
  // sends 503 and the buffer is discarded (audit-or-nothing).
  if (isAgentRequest({ message: updatedMessage })) {
    const rejectionText =
      "Agent mode is disabled in this build. Plan 2.5 §D " +
      "removed the agent surface; the message was not " +
      "processed.";
    writeResponseChunk(response, {
      uuid,
      sources: [],
      type: "abort",
      textResponse: rejectionText,
      error: "agent_mode_disabled",
      close: true,
    });
    await auditAndPersist({
      request: {
        body: { message: updatedMessage },
        params: { slug: workspace.slug },
        user: user
          ? { id: user.id, email: user.email, username: user.username }
          : null,
      },
      llmResponse: rejectionText,
      retrievedChunks: [],
      modelMeta: {
        model: null,
        anythingllm_version: process.env.npm_package_version || null,
        system_prompt: null,
        embedding_model: null,
        chunking: { chunk_tokens: null, overlap: null, top_k: null },
        firm_reference_manifest: null,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0,
        streamed: true,
      },
      workflow: "agent_rejected",
    });
    return;
  }

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
  const VectorDb = getVectorDbClass();

  const messageLimit = workspace?.openAiHistory || 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      attachments,
      close: true,
      error: null,
    });
    // vs-fork Plan 4 §C sub-plan v2 BLOCK-1: §5.3 sparse-matter
    // refusal (browser-stream early-exit, no embeddings yet).
    // Wrapped in auditAndPersist + persistFn so Plan 6 §D
    // negative empty-matter probe can inspect the audit row.
    await auditAndPersist({
      request: {
        body: { message: updatedMessage },
        params: { slug: workspace.slug },
        user: user
          ? { id: user.id, email: user.email, username: user.username }
          : null,
      },
      llmResponse: textResponse,
      retrievedChunks: [],
      modelMeta: {
        model: null,
        anythingllm_version: process.env.npm_package_version || null,
        system_prompt: workspace?.openAiPrompt || "default-v1.0",
        embedding_model: process.env.EMBEDDING_ENGINE || null,
        chunking: {
          chunk_tokens: workspace?.chunk_size ?? null,
          overlap: workspace?.chunk_overlap ?? null,
          top_k: workspace?.topN ?? null,
        },
        firm_reference_manifest: null,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0,
        cw_pass: false,
        citation_check_shape: null,
        streamed: true,
      },
      workflow: chatMode === "query" ? "targeted_query" : "open_chat",
      persistFn: async (auditId) => {
        const result = await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: message,
          response: {
            text: textResponse,
            sources: [],
            type: chatMode,
            attachments,
            citation_check: REFUSAL_CITATION_CHECK,
          },
          threadId: thread?.id || null,
          include: false,
          user,
          auditId,
        });
        if (!result?.chat || result.message) {
          throw new Error(
            `WorkspaceChats.new failed: ${result?.message || "no chat returned"}`
          );
        }
      },
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText;
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  const { rawHistory, chatHistory } = await recentChatHistory({
    user,
    workspace,
    thread,
    messageLimit,
  });

  // Look for pinned documents and see if the user decided to use this feature. We will also do a vector search
  // as pinning is a supplemental tool but it should be used with caution since it can easily blow up a context window.
  // However we limit the maximum of appended context to 80% of its overall size, mostly because if it expands beyond this
  // it will undergo prompt compression anyway to make it work. If there is so much pinned that the context here is bigger than
  // what the model can support - it would get compressed anyway and that really is not the point of pinning. It is really best
  // suited for high-context models.
  await new DocumentManager({
    workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      pinnedDocs.forEach((doc) => {
        const { pageContent, ...metadata } = doc;
        pinnedDocIdentifiers.push(sourceIdentifier(doc));
        contextTexts.push(doc.pageContent);
        sources.push({
          text:
            pageContent.slice(0, 1_000) +
            "...continued on in source document...",
          ...metadata,
        });
      });
    });

  // Inject any parsed files for this workspace/thread/user
  const parsedFiles = await WorkspaceParsedFiles.getContextFiles(
    workspace,
    thread || null,
    user || null
  );
  parsedFiles.forEach((doc) => {
    const { pageContent, ...metadata } = doc;
    contextTexts.push(doc.pageContent);
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: updatedMessage,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
    });
    return;
  }

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [...contextTexts, ...filledSources.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];

  // vs-fork Plan 4 §C.4e: opt-in cross-workspace retrieval
  // (browser-stream surface — same contract as the dev-API
  // surfaces in apiChatHandler.js).
  const firmRefResult = await fetchFirmReferenceChunks({
    workspace,
    input: message,
    matterChunks: sources,
    k: workspace?.topN,
    similarityThreshold: workspace?.similarityThreshold,
    LLMConnector,
  });
  if (firmRefResult.count > 0) {
    contextTexts = [
      ...contextTexts,
      ...firmRefResult.chunks.map((c) => c.text),
    ];
    sources = [
      ...sources,
      ...firmRefResult.chunks
        .map((c) => c.source)
        .filter((s) => s != null),
    ];
  }

  // If in query mode and no context chunks are found from search, backfill, or pins -  do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && contextTexts.length === 0) {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
    });

    // vs-fork Plan 4 §C sub-plan v2 BLOCK-1: §5.3 sparse-matter
    // refusal (browser-stream post-vector-search). Wrapped in
    // auditAndPersist + persistFn for Plan 6 §D negative
    // empty-matter probe.
    await auditAndPersist({
      request: {
        body: { message: updatedMessage },
        params: { slug: workspace.slug },
        user: user
          ? { id: user.id, email: user.email, username: user.username }
          : null,
      },
      llmResponse: textResponse,
      retrievedChunks: [],
      modelMeta: {
        model: null,
        anythingllm_version: process.env.npm_package_version || null,
        system_prompt: workspace?.openAiPrompt || "default-v1.0",
        embedding_model: process.env.EMBEDDING_ENGINE || null,
        chunking: {
          chunk_tokens: workspace?.chunk_size ?? null,
          overlap: workspace?.chunk_overlap ?? null,
          top_k: workspace?.topN ?? null,
        },
        firm_reference_manifest: null,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0,
        cw_pass: false,
        citation_check_shape: null,
        streamed: true,
      },
      workflow: chatMode === "query" ? "targeted_query" : "open_chat",
      persistFn: async (auditId) => {
        const result = await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: message,
          response: {
            text: textResponse,
            sources: [],
            type: chatMode,
            attachments,
            citation_check: REFUSAL_CITATION_CHECK,
          },
          threadId: thread?.id || null,
          include: false,
          user,
          auditId,
        });
        if (!result?.chat || result.message) {
          throw new Error(
            `WorkspaceChats.new failed: ${result?.message || "no chat returned"}`
          );
        }
      },
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt: await chatPrompt(workspace, user),
      userPrompt: updatedMessage,
      contextTexts,
      chatHistory,
      attachments,
    },
    rawHistory
  );

  // If streaming is not explicitly enabled for connector
  // we do regular waiting of a response and send a single chunk.
  if (LLMConnector.streamingEnabled() !== true) {
    console.log(
      `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
    );
    const { textResponse, metrics: performanceMetrics } =
      await LLMConnector.getChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user: user,
      });

    completeText = textResponse;
    metrics = performanceMetrics;
    writeResponseChunk(response, {
      uuid,
      sources,
      type: "textResponseChunk",
      textResponse: completeText,
      close: true,
      error: false,
      metrics,
    });
  } else {
    const stream = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user: user,
    });
    completeText = await LLMConnector.handleStream(response, stream, {
      uuid,
      sources,
    });
    metrics = stream.metrics;
  }

  if (completeText?.length > 0) {
    // vs-fork Plan 4 §G: workflow detection.
    // Default → chatMode-derived (targeted_query | open_chat).
    // If the operator's message began with a slash command that
    // grepCommand recognised (so `updatedMessage !== message`), the
    // workflow is the slash-token name minus its leading slashes.
    // This surfaces the slash-command path to the audit row so
    // operators can trace which preset workflow ran.
    let workflow = chatMode === "query" ? "targeted_query" : "open_chat";
    const leadingToken = (message || "").trim().split(/\s+/)[0] || "";
    if (leadingToken.startsWith("/") && updatedMessage !== message) {
      workflow = leadingToken.replace(/^\/+/, "");
    }

    // §E.2 commit 4: shape-only citation post-check after the
    // streamed LLM completion is fully assembled. Same contract
    // as apiChatHandler. Helper never throws.
    const citationCheck = await runCitationPostcheck(completeText);

    // vs-fork Plan 1 Task 10: AUDIT FIRST, PERSIST SECOND.
    let chat;
    await auditAndPersist({
      request: {
        body: { message },
        params: { slug: workspace.slug },
        user: user
          ? { id: user.id, email: user.email, username: user.username }
          : null,
      },
      llmResponse: completeText,
      retrievedChunks: sources,
      modelMeta: {
        model: LLMConnector.model || workspace?.chatModel || null,
        anythingllm_version: process.env.npm_package_version || null,
        system_prompt: workspace?.openAiPrompt || "default-v1.0",
        embedding_model: process.env.EMBEDDING_ENGINE || null,
        chunking: {
          chunk_tokens: workspace?.chunk_size ?? null,
          overlap: workspace?.chunk_overlap ?? null,
          top_k: workspace?.topN ?? null,
        },
        // vs-fork Plan 4 §C.4e: cross-workspace audit fields
        // populated from the firm-reference helper result
        // (firmRefResult, captured above after the matter
        // retrieval). manifest_sha null when count===0 per
        // Plan 4 §C sub-plan v3 FLAG-2 / v4 FLAG-3.
        firm_reference_manifest: firmRefResult.manifest_sha,
        cw_pass: firmRefResult.count > 0,
        cross_workspace_with:
          firmRefResult.count > 0 ? [FIRM_REFERENCE_NAMESPACE] : undefined,
        cross_workspace_chunks: firmRefResult.count,
        tokens_in: metrics?.prompt_tokens ?? null,
        tokens_out: metrics?.completion_tokens ?? null,
        latency_ms: metrics?.duration ? Math.round(metrics.duration * 1000) : null,
        streamed: true,
        // §E.2 commit 4: boolean shape — audit-middleware reads
        // this on the same commit (schema bump below).
        citation_check_shape: citationCheck.ok,
      },
      workflow,
      persistFn: async (auditId) => {
        // BLOCK 1 + BLOCK 3 fix: see apiChatHandler.chatSync.
        const result = await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: message,
          response: {
            text: completeText,
            sources,
            type: chatMode,
            attachments,
            metrics,
            // §E.2 commit 4: full result for the chat-row blob.
            citation_check: citationCheck,
          },
          threadId: thread?.id || null,
          user,
          auditId,
        });
        if (!result?.chat || result.message) {
          throw new Error(
            `WorkspaceChats.new failed: ${result?.message || "no chat returned"}`
          );
        }
        chat = result.chat;
      },
    });

    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      chatId: chat?.id,
      metrics,
    });
    return;
  }

  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
    metrics,
  });
  return;
}

module.exports = {
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
