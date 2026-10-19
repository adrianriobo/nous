#!/usr/bin/env node
// Minimal MCP streamable HTTP server for integration testing.
//
// Behaviour mirrors session-based servers (like the Chai bot):
//   POST initialize  → 200 + Mcp-Session-Id header + capabilities + instructions
//   POST tools/list  → 200 with tool list (requires valid Mcp-Session-Id)
//   POST tools/call  → 200 with mock result (requires valid Mcp-Session-Id)
//   POST tools/list without session → 400 "Missing session ID"
//
// Override port with MOCK_MCP_PORT (default 4011).

import http from "http";

const PORT    = parseInt(process.env.MOCK_MCP_PORT ?? "4011", 10);
const SESSION = "mock-session-abc123";

const TOOLS = [
  {
    name: "test_tool",
    description: "A test tool for MCP integration testing.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

const INSTRUCTIONS =
  "Mock MCP server for integration testing. Use test_tool for test queries.";

http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405); res.end(); return;
  }

  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(body); }
    catch { res.writeHead(400); res.end(); return; }

    const sid = req.headers["mcp-session-id"];

    if (msg.method === "initialize") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": SESSION,
      });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mock-mcp", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        },
      }));
      return;
    }

    if (!sid || sid !== SESSION) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: "server-error",
        error: { code: -32600, message: "Bad Request: Missing session ID" },
      }));
      return;
    }

    if (msg.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } }));
      return;
    }

    if (msg.method === "tools/call") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: `mock result for ${msg.params?.name}` }] },
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
  });
}).listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`Mock MCP server listening on :${PORT}\n`);
});
