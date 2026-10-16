#!/usr/bin/env node
/**
 * Minimal mock server for the Vertex AI Anthropic streaming endpoint.
 *
 * Listens on PORT (default 4010) and responds to any POST with a valid
 * Anthropic SSE stream. Used in CI integration tests so real Vertex AI
 * credentials are not required.
 *
 * The MOCK_RESPONSE env var overrides the response text.
 */
import http from "http";

const PORT = parseInt(process.env.PORT ?? "4010", 10);
const RESPONSE_TEXT =
  process.env.MOCK_RESPONSE ?? "Hello from haropz mock vertex server";

/** Write a single SSE event */
function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  // Drain the request body before responding
  req.resume();
  req.on("end", () => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    sse(res, {
      type: "message_start",
      message: {
        id: "mock-msg-001",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-haiku-mock",
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    });

    sse(res, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });

    sse(res, { type: "ping" });

    // Stream the response text character by character so the SSE parser
    // exercises the delta path properly.
    for (const ch of RESPONSE_TEXT) {
      sse(res, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ch },
      });
    }

    sse(res, { type: "content_block_stop", index: 0 });

    sse(res, {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: RESPONSE_TEXT.length },
    });

    sse(res, { type: "message_stop" });

    res.end();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`mock-vertex-server listening on port ${PORT}\n`);
});
