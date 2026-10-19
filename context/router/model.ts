import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TIERS = [
  { provider: "vertex-anthropic", id: "claude-haiku-4-5@20251001" },  // 0 — cheap / simple
  { provider: "vertex-anthropic", id: "claude-sonnet-4-5@20250929" }, // 1 — balanced planner
  { provider: "vertex-anthropic", id: "claude-opus-4-6" },            // 2 — heavy thinker
] as const;

export const GEMINI_FLASH_CANDIDATES: { provider: string; id: string }[] = [
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

export function isComplex(messages: readonly any[]): boolean {
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

export function hasWritten(messages: readonly any[]): boolean {
  return messages.some((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(
      (b: any) => b.type === "tool_use" && /edit|write|bash|create|patch/i.test(b.name ?? "")
    );
  });
}

export function registerRouter(pi: ExtensionAPI) {
  let geminiModel: any = undefined;
  let geminiId = "";

  function resolveGemini(ctx: any): { model: any; id: string } | null {
    if (geminiModel === undefined) {
      for (const c of GEMINI_FLASH_CANDIDATES) {
        const m = ctx.modelRegistry.find(c.provider, c.id);
        if (m) { geminiModel = m; geminiId = c.id; break; }
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
