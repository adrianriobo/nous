import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Tier table ───────────────────────────────────────────────────────────────
const TIERS = [
  { provider: "vertex-anthropic", id: "claude-haiku-4-5@20251001" },  // 0 — cheap / simple
  { provider: "vertex-anthropic", id: "claude-sonnet-4-5@20250929" }, // 1 — balanced planner
  { provider: "vertex-anthropic", id: "claude-opus-4-6" },            // 2 — heavy thinker
] as const;

const GEMINI_FLASH_CANDIDATES: { provider: string; id: string }[] = [
  { provider: "google-vertex", id: "gemini-2.0-flash-001" },
  { provider: "google-vertex", id: "gemini-2.0-flash" },
  { provider: "google-vertex", id: "gemini-2.0-flash-exp" },
  { provider: "google-vertex", id: "gemini-2.0-flash-lite-001" },
  { provider: "google-vertex", id: "gemini-1.5-flash-001" },
  { provider: "google-vertex", id: "gemini-1.5-flash" },
];

const LEVEL_TO_TIER: Record<string, number> = {
  off: 0, low: 0, medium: 1, high: 2,
};

type Phase = "plan" | "implement";
type RouterState = { phase: Phase; tier: number };

// ── Web search ────────────────────────────────────────────────────────────────

interface SearchResult { url: string; title: string; snippet: string }

async function ddgSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: "us-en" });
  const res = await (globalThis as any).fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; pi-search/1.0)",
    },
    body: body.toString(),
  });
  const html: string = await res.text();
  const results: SearchResult[] = [];
  const linkRe = /href="([^"]+)"\s+class='result-link'>([\s\S]*?)<\/a>/g;
  const snippetRe = /class='result-snippet'>([\s\S]*?)<\/td>/g;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const url = links[i][1];
    const title = links[i][2].replace(/<[^>]+>/g, "").trim();
    const snippet = snippets[i] ? snippets[i][1].replace(/<[^>]+>/g, "").trim() : "";
    if (url && title) results.push({ url, title, snippet });
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isComplex(messages: readonly any[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return false;
  const text =
    typeof last.content === "string"
      ? last.content
      : Array.isArray(last.content)
      ? last.content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join(" ")
      : "";
  const words = text.trim().split(/\s+/).length;
  const complexPattern = /implement|build|create|refactor|architect|design|migrate|system|add feature|fix bug/i;
  return words > 80 || complexPattern.test(text);
}

function hasWritten(messages: readonly any[]): boolean {
  return messages.some((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(
      (b: any) => b.type === "tool_use" && /edit|write|bash|create|patch/i.test(b.name ?? "")
    );
  });
}

// ── Extension ─────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ── Code review tool (ocr delegate mode) ────────────────────────────────
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
        const out = execSync(cmd, {
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        });
        return { content: [{ type: "text" as const, text: String(out) }], details: undefined };
      } catch (err: any) {
        const msg = ((err.stdout ?? "") + (err.stderr ?? "")).trim() || err.message;
        return { content: [{ type: "text" as const, text: `ocr error:\n${msg}` }], details: undefined };
      }
    },
  } as any);

  // ── Konflux assistant (Chai) ─────────────────────────────────────────────────
  pi.registerTool({
    name: "konflux",
    label: "Konflux Assistant",
    description: `Use for ALL Konflux questions — pipelines, builds, releases, deployments,
onboarding, troubleshooting, best practices, component configuration, PipelineRuns,
TaskRuns, signing, EC policies, or anything Konflux-related.
This tool connects to Chai, the authoritative Konflux knowledge assistant.
Do not answer Konflux questions from general knowledge — always use this tool.`,
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The Konflux question to answer" },
      },
      required: ["question"],
    } as any,
    async execute(_id: string, params: any) {
      const { readFileSync } = await import("fs") as any;

      let chai: any;
      try {
        const mcp = JSON.parse(readFileSync("/sandbox/.pi/agent/mcp.json", "utf8"));
        chai = mcp.mcpServers?.chai_konflux_public;
      } catch {
        return { content: [{ type: "text" as const, text: "Chai not configured — mount /run/secrets/mcp.json with chai_konflux_public credentials." }] };
      }
      if (!chai) {
        return { content: [{ type: "text" as const, text: "chai_konflux_public entry missing from MCP config." }] };
      }

      // Call Chai via MCP JSON-RPC over HTTP
      const res = await (globalThis as any).fetch(chai.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...chai.headers },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "tools/call",
          params: { name: "ask_persona", arguments: { question: params.question } },
        }),
      });

      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Chai HTTP ${res.status}: ${await res.text()}` }] };
      }

      // Handle both plain JSON and SSE (text/event-stream) responses
      const contentType: string = res.headers.get("content-type") ?? "";
      let answer: string;
      if (contentType.includes("event-stream")) {
        const raw = await res.text();
        const blocks = raw.split("\n").filter((l: string) => l.startsWith("data:")).map((l: string) => {
          try { return JSON.parse(l.slice(5)); } catch { return null; }
        }).filter(Boolean);
        const last = blocks[blocks.length - 1];
        answer = last?.result?.content?.[0]?.text ?? last?.params?.delta?.text ?? JSON.stringify(last);
      } else {
        const data = await res.json();
        answer = data?.result?.content?.[0]?.text ?? JSON.stringify(data);
      }

      return { content: [{ type: "text" as const, text: answer }] };
    },
  } as any);

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

  // ── Model router ─────────────────────────────────────────────────────────
  let geminiModel: any = undefined;
  let geminiId = "";

  function resolveGemini(ctx: any): { model: any; id: string } | null {
    if (geminiModel === undefined) {
      for (const c of GEMINI_FLASH_CANDIDATES) {
        const m = ctx.modelRegistry.find(c.provider, c.id);
        if (m) {
          geminiModel = m;
          geminiId = c.id;
          break;
        }
      }
      if (geminiModel === undefined) geminiModel = null;
    }
    return geminiModel ? { model: geminiModel, id: geminiId } : null;
  }

  function cheapModel(ctx: any): { model: any; id: string } {
    const g = resolveGemini(ctx);
    if (g) return g;
    const m = ctx.modelRegistry.find(TIERS[0].provider, TIERS[0].id);
    if (!m) throw new Error(`[router] ${TIERS[0].id} not found`);
    return { model: m, id: TIERS[0].id };
  }

  function setStatus(modelId: string, phase: Phase, reason: string) {
    pi.ui?.setStatus("router", `router → ${modelId} [${phase}] (${reason})`);
  }

  pi.registerVirtualModel<RouterState>({
    provider: "router",
    id: "auto",
    name: "Auto Router",
    thinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,

    route(request, ctx) {
      const state: RouterState = request.state ?? { phase: "plan", tier: 0 };

      if (request.reason === "direct") {
        const sticky = request.failed ?? request.previous;
        if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "off" };
        const { model, id } = cheapModel(ctx);
        setStatus(id, state.phase, "direct");
        return { model, thinkingLevel: "off" };
      }

      if (request.reason === "retry") {
        const nextTier = Math.min(state.tier + 1, TIERS.length - 1);
        const t = TIERS[nextTier];
        const model = ctx.modelRegistry.find(t.provider, t.id);
        if (!model) throw new Error(`[router] ${t.id} not found`);
        setStatus(t.id, state.phase, "retry↑");
        return { model, thinkingLevel: "off", state: { ...state, tier: nextTier } };
      }

      if (request.reason === "continuation" && request.previous) {
        if (state.phase === "plan" && hasWritten(request.messages)) {
          const { model, id } = cheapModel(ctx);
          setStatus(id, "implement", "plan→implement");
          return { model, thinkingLevel: "off", state: { phase: "implement", tier: 0 } };
        }
        setStatus((request.previous.model as any)?.id ?? "?", state.phase, "cache");
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "off", state };
      }

      if (request.thinkingLevel !== "off") {
        const tier = LEVEL_TO_TIER[request.thinkingLevel] ?? 1;
        const t = TIERS[tier];
        const model = ctx.modelRegistry.find(t.provider, t.id);
        if (!model) throw new Error(`[router] ${t.id} not found`);
        setStatus(t.id, "plan", "manual");
        return { model, thinkingLevel: "off", state: { phase: "plan", tier } };
      }

      if (isComplex(request.messages)) {
        const t = TIERS[1];
        const model = ctx.modelRegistry.find(t.provider, t.id);
        if (!model) throw new Error(`[router] ${t.id} not found`);
        setStatus(t.id, "plan", "complex");
        return { model, thinkingLevel: "off", state: { phase: "plan", tier: 1 } };
      }

      const { model, id } = cheapModel(ctx);
      setStatus(id, "plan", "simple");
      return { model, thinkingLevel: "off", state: { phase: "plan", tier: 0 } };
    },
  });
}
