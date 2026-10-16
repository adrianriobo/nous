#!/usr/bin/env node
/**
 * Multi-turn mock server for the Vertex AI Anthropic streaming endpoint.
 *
 * Supports two scenarios via MOCK_SCENARIO env var:
 *   - "text"       (default) Plain text response — used for smoke / policy tests.
 *   - "web_search" First turn returns a web_search tool_use; after receiving the
 *                  tool_result it returns a final text response. Used to test that
 *                  the agent can execute the web_search tool end-to-end.
 *
 * Port defaults to 4010; override with PORT env var.
 */
import http from "http";

const PORT = parseInt(process.env.PORT ?? "4010", 10);
const SCENARIO = process.env.MOCK_SCENARIO ?? "text";
const FINAL_TEXT = "Task completed. Search results were retrieved successfully.";
const PLAIN_TEXT = process.env.MOCK_RESPONSE ?? "Hello from haropz mock vertex server";

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(res, text) {
  sse(res, {
    type: "message_start",
    message: { id: "mock-msg", type: "message", role: "assistant", content: [],
      model: "claude-haiku-mock", usage: { input_tokens: 10, output_tokens: 0 } },
  });
  sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const ch of text) {
    sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } });
  }
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: text.length },
  });
  sse(res, { type: "message_stop" });
  res.end();
}

function streamToolUse(res, toolName, toolId, toolInput) {
  const inputStr = JSON.stringify(toolInput);
  sse(res, {
    type: "message_start",
    message: { id: "mock-msg-tool", type: "message", role: "assistant", content: [],
      model: "claude-haiku-mock", usage: { input_tokens: 10, output_tokens: 0 } },
  });
  sse(res, {
    type: "content_block_start", index: 0,
    content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
  });
  sse(res, {
    type: "content_block_delta", index: 0,
    delta: { type: "input_json_delta", partial_json: inputStr },
  });
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  sse(res, { type: "message_stop" });
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405); res.end("Method Not Allowed"); return;
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (SCENARIO === "web_search") {
      // Multi-turn: if request already has a tool_result → send final text.
      // Otherwise → request a web_search tool call.
      const messages = parsed.messages ?? [];
      const hasToolResult = messages.some((m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result")
      );
      if (hasToolResult) {
        streamText(res, FINAL_TEXT);
      } else {
        streamToolUse(res, "web_search", "toolu_mock_ws_001", { query: "NVIDIA OpenShell agent runtime" });
      }
    } else {
      streamText(res, PLAIN_TEXT);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`mock-vertex-server listening on port ${PORT} (scenario=${SCENARIO})\n`);
});
