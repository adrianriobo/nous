import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverTools, callMcpToolSSE, callMcpToolStreamable, type DiscoveryResult } from "./router/mcp";
import { ddgSearch } from "./router/search";
import { registerEnmaasProvider, discoverTiers } from "./router/enmaas";
import { registerRouter } from "./router/model";
import { registerSubagent } from "./router/subagent";
import { wikiSearch, wikiRead, wikiIngest, WIKI_PATH } from "./router/wiki";
import { existsSync } from "fs";

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

  // ── LLM-Wiki tools (OKF 2.0) ────────────────────────────────────────────────
  // Registered only when the wiki is mounted at WIKI_PATH (default /sandbox/wiki).
  if (existsSync(WIKI_PATH)) {
    process.stderr.write(`[nous] wiki: found at ${WIKI_PATH} — registering wiki_search, wiki_read, wiki_ingest\n`);

    pi.registerTool({
      name: "wiki_search",
      label: "Wiki Search",
      description: `Search the personal knowledge wiki (OKF 2.0 format) mounted at ${WIKI_PATH}.
The wiki is a collection of curated markdown pages with YAML frontmatter (type, title, description, tags).
Use this before web_search when looking for domain knowledge, personal notes, or context about the user's projects.
The search scores results by matches in title (highest), description, tags, and body text.
After finding relevant pages, use wiki_read to fetch their full content.`,
      parameters: {
        type: "object",
        properties: {
          query:  { type: "string", description: "Keywords or phrase to search for" },
          limit:  { type: "number", description: "Maximum results to return (default 5)", default: 5 },
        },
        required: ["query"],
      } as any,
      async execute(_id: string, params: any) {
        const result = wikiSearch(String(params.query), Number(params.limit ?? 5));
        return { content: [{ type: "text" as const, text: result }] };
      },
    } as any);

    pi.registerTool({
      name: "wiki_read",
      label: "Wiki Read",
      description: `Read a specific page from the personal knowledge wiki at ${WIKI_PATH}.
Provide the relative path returned by wiki_search (e.g. "concepts/topic.md").
The .md extension is optional. Returns the full OKF markdown content including frontmatter.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the wiki page (e.g. 'concepts/topic.md')" },
        },
        required: ["path"],
      } as any,
      async execute(_id: string, params: any) {
        const result = wikiRead(String(params.path));
        return { content: [{ type: "text" as const, text: result }] };
      },
    } as any);

    pi.registerTool({
      name: "wiki_ingest",
      label: "Wiki Ingest",
      description: `Save a new source document to the wiki's raw/assets/ folder for the processor agent to pick up.
Use this to feed new content (notes, summaries, transcripts, findings) into the wiki pipeline.
The processor agent reads raw/assets/ and integrates the content into the wiki on its next run.
Do NOT use this to write wiki pages directly — the processor agent handles that.`,
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename for the new asset (e.g. 'meeting-notes-2026-10-22.md')" },
          content:  { type: "string", description: "Text content to save" },
        },
        required: ["filename", "content"],
      } as any,
      async execute(_id: string, params: any) {
        const result = wikiIngest(String(params.filename), String(params.content));
        return { content: [{ type: "text" as const, text: result }] };
      },
    } as any);
  } else {
    process.stderr.write(`[nous] wiki: not mounted (${WIKI_PATH} not found) — wiki tools skipped\n`);
  }

  // ── EnMaaS provider + model router ─────────────────────────────────────────
  // Register the EnMaaS provider first so the gateway models exist in the
  // registry, then probe the gateway at boot to build live tiers from the
  // models it confirms. Falls back to hardcoded defaults when the gateway
  // or credentials are unavailable.
  registerEnmaasProvider(pi);
  registerSubagent(pi);
  const tiers = await discoverTiers();
  registerRouter(pi, tiers);
}
