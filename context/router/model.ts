import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TIERS = [
  { provider: "vertex-anthropic", id: "claude-haiku-4-5@20251001" },  // 0 — trivial / implement phase ($1/1M)
  { provider: "vertex-anthropic", id: "claude-sonnet-4-5@20250929" }, // 1 — retry intermediate ($3/1M)
  { provider: "vertex-anthropic", id: "claude-opus-4-6" },            // 2 — default plan ($5/1M)
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
  off: 2, low: 0, medium: 1, high: 2,
};

type Phase = "plan" | "implement";
type RouterState = { phase: Phase; tier: number };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join(" ");
  return "";
}

function lastUserText(messages: readonly any[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last ? extractText(last.content) : "";
}

// A request is trivially simple only when it's very short AND non-technical.
// Everything else defaults to Sonnet so the user gets a capable model.
export function isTrivial(messages: readonly any[]): boolean {
  const text = lastUserText(messages).trim();
  const words = text.split(/\s+/).length;
  if (words >= 20) return false;
  const technicalPattern =
    /code|function|class|method|error|bug|test|api|config|deploy|docker|container|kubernetes|k8s|git|build|run|install|file|script|command|variable|database|query|request|response|refactor|implement|create|generate|write|review|explain|analyze|debug|fix|help/i;
  return !technicalPattern.test(text);
}

// Kept for external callers / tests — now an alias of !isTrivial.
export function isComplex(messages: readonly any[]): boolean {
  return !isTrivial(messages);
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

  // Cheapest available model — used only for the implement phase.
  function cheapModel(ctx: any): { model: any; id: string } {
    const g = resolveGemini(ctx);
    if (g) return g;
    const m = ctx.modelRegistry.find(TIERS[0].provider, TIERS[0].id);
    if (!m) throw new Error(`[router] ${TIERS[0].id} not found`);
    return { model: m, id: TIERS[0].id };
  }

  // Default planning model — Opus 4.6 is the best available on Vertex at $5/1M.
  // Upgrade to a newer model by bumping PI_PROVIDER_VERTEX_VERSION when Claude 5
  // models appear on Vertex AI.
  function planModel(ctx: any): { model: any; id: string } {
    const t = TIERS[2];
    const m = ctx.modelRegistry.find(t.provider, t.id);
    if (!m) throw new Error(`[router] ${t.id} not found`);
    return { model: m, id: t.id };
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
      const state: RouterState = request.state ?? { phase: "plan", tier: 2 };

      // ── Direct model selection (user picked a specific model) ──────────────
      if (request.reason === "direct") {
        const sticky = request.failed ?? request.previous;
        if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "off" };
        const { model, id } = planModel(ctx);
        setStatus(id, state.phase, "direct");
        return { model, thinkingLevel: "off" };
      }

      // ── Retry — escalate one tier ──────────────────────────────────────────
      if (request.reason === "retry") {
        const nextTier = Math.min(state.tier + 1, TIERS.length - 1);
        const t = TIERS[nextTier];
        const model = ctx.modelRegistry.find(t.provider, t.id);
        if (!model) throw new Error(`[router] ${t.id} not found`);
        setStatus(t.id, state.phase, "retry↑");
        return { model, thinkingLevel: "off", state: { ...state, tier: nextTier } };
      }

      // ── Continuation — keep phase; switch to implement when writing starts ─
      if (request.reason === "continuation" && request.previous) {
        if (state.phase === "plan" && hasWritten(request.messages)) {
          const { model, id } = cheapModel(ctx);
          setStatus(id, "implement", "plan→implement");
          return { model, thinkingLevel: "off", state: { phase: "implement", tier: 0 } };
        }
        if (state.phase === "implement") {
          const { model, id } = cheapModel(ctx);
          setStatus(id, "implement", "implement");
          return { model, thinkingLevel: "off", state };
        }
        // Still in plan phase — re-evaluate complexity so the model can
        // upgrade within a session if the user asks something harder.
        if (!isTrivial(request.messages)) {
          const { model, id } = planModel(ctx);
          setStatus(id, "plan", "plan");
          return { model, thinkingLevel: "off", state: { ...state, tier: 1 } };
        }
        const { model, id } = cheapModel(ctx);
        setStatus(id, "plan", "trivial");
        return { model, thinkingLevel: "off", state: { ...state, tier: 0 } };
      }

      // ── Explicit thinking level override ───────────────────────────────────
      if (request.thinkingLevel && request.thinkingLevel !== "off") {
        const tier = LEVEL_TO_TIER[request.thinkingLevel] ?? 1;
        const t = TIERS[tier];
        const model = ctx.modelRegistry.find(t.provider, t.id);
        if (!model) throw new Error(`[router] ${t.id} not found`);
        setStatus(t.id, "plan", "manual");
        return { model, thinkingLevel: "off", state: { phase: "plan", tier } };
      }

      // ── New turn: default to Sonnet, downgrade only for trivial queries ────
      if (isTrivial(request.messages)) {
        const { model, id } = cheapModel(ctx);
        setStatus(id, "plan", "trivial");
        return { model, thinkingLevel: "off", state: { phase: "plan", tier: 0 } };
      }

      const { model, id } = planModel(ctx);
      setStatus(id, "plan", "plan");
      return { model, thinkingLevel: "off", state: { phase: "plan", tier: 1 } };
    },
  });
}
