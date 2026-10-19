import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverTools, callMcpToolSSE, callMcpToolStreamable, type DiscoveryResult } from "./router/mcp";
import { ddgSearch } from "./router/search";
import { registerRouter } from "./router/model";

export default async function (pi: ExtensionAPI) {
  // ── Code review tool (ocr delegate mode) ───────────────────────────────────
  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description: `Run Alibaba open-code-review (ocr) in delegate mode.
ocr analyses the target files with its rule engine and emits structured review
instructions for you to act on. After this tool returns, read the instructions
and perform the review using your other tools (read, bash, etc.).
Use 'preview' mode first to see what files would be selected before doing the full review.`,
    parameters: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "File paths to review. Leave empty to let ocr auto-detect all changed files in the git workspace.",
        },
        mode: {
          type: "string",
          enum: ["rule", "preview"],
          description: "'rule' performs the full review (default). 'preview' shows which files ocr would select without running the review.",
          default: "rule",
        },
      },
      required: [],
    } as any,
    async execute(_id: string, params: any) {
      const { execSync } = await import("child_process") as any;
      const files: string[] = params.files ?? [];
      const mode: string = params.mode ?? "rule";
      const cmd = ["ocr", "delegate", mode, ...files].join(" ");
      try {
        const out = execSync(cmd, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 });
        return { content: [{ type: "text" as const, text: String(out) }], details: undefined };
      } catch (err: any) {
        const msg = ((err.stdout ?? "") + (err.stderr ?? "")).trim() || err.message;
        return { content: [{ type: "text" as const, text: `ocr error:\n${msg}` }], details: undefined };
      }
    },
  } as any);

  // ── External MCP servers — discover and register as first-class tools ───────
  // pi awaits the default export, so async discovery here runs before pi
  // finalises its tool list — tools appear in <functions> from the first turn.
  {
    const fs = require("fs") as typeof import("fs");
    let mcpServers: Record<string, any> = {};
    try {
      const mcp = JSON.parse(fs.readFileSync("/sandbox/.pi/agent/mcp.json", "utf8"));
      mcpServers = mcp.mcpServers ?? {};
    } catch { /* no mcp.json mounted */ }

    const registered: string[] = [];

    for (const [serverName, server] of Object.entries(mcpServers)) {
      if (!(server as any)?.url) continue;
      const { url, headers = {}, hint } = server as any;
      let result: DiscoveryResult = { tools: [], instructions: "" };
      try {
        result = await discoverTools(url, headers);
        process.stderr.write(`[nous] ${serverName}: discovered tools: ${result.tools.map((t: any) => t.name).join(", ") || "(none)"}\n`);
      } catch (e: any) {
        process.stderr.write(`[nous] ${serverName}: discovery failed — ${(e as Error).message}\n`);
        pi.ui?.setStatus("mcp", `[nous] ${serverName}: discovery failed — ${(e as Error).message}`);
        continue;
      }

      // Routing prefix: explicit hint > first 400 chars of server instructions > nothing.
      const rawPrefix: string = hint ?? result.instructions ?? "";
      const prefix = rawPrefix.length > 0
        ? `[Routing: ${rawPrefix.slice(0, 400).trim()}]\n\n`
        : "";

      for (const tool of result.tools) {
        const toolName = tool.name as string;
        pi.registerTool({
          name: `${serverName}_${toolName}`,
          label: `${serverName}: ${toolName}`,
          description: `${prefix}${tool.description ?? `${serverName} tool: ${toolName}`}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {}, required: [] },
          async execute(_id: string, params: any) {
            try {
              const text = await callMcpToolSSE(url, headers, toolName, params);
              return { content: [{ type: "text" as const, text }] };
            } catch {
              const text = await callMcpToolStreamable(url, headers, toolName, params);
              return { content: [{ type: "text" as const, text }] };
            }
          },
        } as any);
        registered.push(`${serverName}_${toolName}`);
      }
    }

    if (registered.length > 0) pi.ui?.setStatus("mcp", `MCP: ${registered.join(", ")}`);
  }

  // ── Web search tool ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using DuckDuckGo. Use this whenever you need current information: GitHub projects, documentation, recent news, package details, or any live data. Always prefer searching over saying you cannot access the internet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results to return (1-10, default 5)", default: 5 },
      },
      required: ["query"],
    } as any,
    async execute(_id: string, params: any) {
      const { query, count = 5 } = params;
      try {
        const results = await ddgSearch(String(query), Number(count));
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No results found for: ${query}` }], details: undefined };
        }
        const text = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}`)
          .join("\n\n");
        return { content: [{ type: "text" as const, text }], details: undefined };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Search error: ${err.message}` }], details: undefined };
      }
    },
  } as any);

  // ── Model router ────────────────────────────────────────────────────────────
  registerRouter(pi);
}
