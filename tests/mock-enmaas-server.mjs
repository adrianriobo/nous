#!/usr/bin/env node
/**
 * Mock EnMaaS gateway for integration tests.
 *
 * Implements the OpenAI-compatible endpoints pi uses:
 *   GET  /v1/models           — model list (boot-time tier discovery)
 *   POST /v1/chat/completions — SSE streaming responses
 *
 * Supports scenarios via MOCK_SCENARIO env var:
 *   - "text"        (default) Plain text response — used for smoke / policy tests.
 *   - "web_search"  First turn returns a web_search tool_use; after receiving the
 *                   tool result it returns a final text response. Used to test that
 *                   the agent can execute the web_search tool end-to-end.
 *   - "wiki_search" First turn returns a wiki_search tool_use; after receiving the
 *                   tool result it returns a final text response. Used to test that
 *                   the wiki tools are wired up and can return results.
 *   - "wiki_ingest" First turn returns a wiki_ingest tool_use; after receiving the
 *                   tool result it returns a final text response. Used to test that
 *                   wiki_ingest writes to raw/assets/.
 *
 * Port defaults to 4010; override with PORT env var.
 */
import http from "http";

const PORT = parseInt(process.env.PORT ?? "4010", 10);
const SCENARIO = process.env.MOCK_SCENARIO ?? "text";
const FINAL_TEXT = "Task completed. Search results were retrieved successfully.";
const WIKI_FINAL_TEXT = "Wiki lookup complete. Found information about nous agent.";
const WIKI_INGEST_FINAL_TEXT = "Ingest complete. Content saved to wiki assets.";
const PLAIN_TEXT = process.env.MOCK_RESPONSE ?? "Hello from haropz mock enmaas server";

// Models listed by the mock gateway — mirrors the EnMaaS tier candidates.
const MODELS = [
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-5.4-mini",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "rits/zai-org/glm-5-3",
  "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
];

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunk(model, delta, finish_reason = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

function usageChunk(model, promptTokens, completionTokens) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// OpenAI SSE terminator. The pi OpenAI-completions client parses this stream
// with the official `openai` SDK. The SDK needs the sentinel event to close the
// stream cleanly: without it pi reports "malformed server-sent event JSON" and
// ends the turn with stopReason "error".
const SSE_DONE = "data: [DONE]\n\n";

function finishStream(res) {
  res.write(SSE_DONE);
  res.end();
}

function streamText(res, text, model) {
  sse(res, chunk(model, { role: "assistant", content: "" }));
  for (const ch of text) {
    sse(res, chunk(model, { content: ch }));
  }
  sse(res, chunk(model, {}, "stop"));
  sse(res, usageChunk(model, 10, text.length));
  finishStream(res);
}

function streamToolUse(res, toolName, toolId, toolInput, model) {
  const args = JSON.stringify(toolInput);
  sse(res, chunk(model, { role: "assistant", content: null }));
  sse(res, chunk(model, {
    tool_calls: [{
      index: 0,
      id: toolId,
      type: "function",
      function: { name: toolName, arguments: "" },
    }],
  }));
  sse(res, chunk(model, {
    tool_calls: [{ index: 0, function: { arguments: args } }],
  }));
  sse(res, chunk(model, {}, "tool_calls"));
  sse(res, usageChunk(model, 10, 20));
  finishStream(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Model list — used by the router at boot to discover tiers.
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "mock" })),
    }));
    return;
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  let body = "";
  req.on("data", (chunkData) => { body += chunkData; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    const model = parsed.model ?? "mock-model";
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // OpenAI format: tool results arrive as messages with role "tool".
    const messages = parsed.messages ?? [];
    const hasToolResult = messages.some((m) => m.role === "tool");

    if (SCENARIO === "web_search") {
      if (hasToolResult) {
        streamText(res, FINAL_TEXT, model);
      } else {
        streamToolUse(res, "web_search", "call_mock_ws_001", { query: "NVIDIA OpenShell agent runtime" }, model);
      }
    } else if (SCENARIO === "wiki_search") {
      if (hasToolResult) {
        streamText(res, WIKI_FINAL_TEXT, model);
      } else {
        streamToolUse(res, "wiki_search", "call_mock_wiki_001", { query: "nous", limit: 3 }, model);
      }
    } else if (SCENARIO === "wiki_ingest") {
      if (hasToolResult) {
        streamText(res, WIKI_INGEST_FINAL_TEXT, model);
      } else {
        streamToolUse(res, "wiki_ingest", "call_mock_wiki_002", { filename: "ci-test-note.md", content: "CI integration test content" }, model);
      }
    } else {
      streamText(res, PLAIN_TEXT, model);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`mock-enmaas-server listening on port ${PORT} (scenario=${SCENARIO})\n`);
});
