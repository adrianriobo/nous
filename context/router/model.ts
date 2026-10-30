import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLASH_CANDIDATES, type Tier } from "./enmaas";

// Routing logic for the virtual router/auto model. Tier layout:
//   tiers[0]             = cheapest (implement phase, trivial queries)
//   tiers[tiers.length-1] = best (plan-phase default)
// Tier candidates, discovery, and the provider live in ./enmaas.

type Phase = "plan" | "implement";
type RouterState = { phase: Phase; tier: number };

// ── Routing helpers ────────────────────────────────────────────────────────────

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

export function isTrivial(messages: readonly any[]): boolean {
  const text = lastUserText(messages).trim();
  const words = text.split(/\s+/).length;
  if (words >= 20) return false;
  const technicalPattern =
    /code|function|class|method|error|bug|test|api|config|deploy|docker|container|kubernetes|k8s|git|build|run|install|file|script|command|variable|database|query|request|response|refactor|implement|create|generate|write|review|explain|analyze|debug|fix|help/i;
  return !technicalPattern.test(text);
}

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

// ── Router registration ────────────────────────────────────────────────────────

export function registerRouter(pi: ExtensionAPI, tiers: Tier[]) {
  // Tier layout: tiers[0] = cheapest, tiers[tiers.length-1] = best/default
  const lastIdx = tiers.length - 1;
  let flashModel: any = undefined;
  let flashId = "";

  function resolveFlash(ctx: any): { model: any; id: string } | null {
    if (flashModel === undefined) {
      for (const c of FLASH_CANDIDATES) {
        const m = ctx.modelRegistry.find(c.provider, c.id);
        if (m) { flashModel = m; flashId = c.id; break; }
      }
      if (flashModel === undefined) flashModel = null;
    }
    return flashModel ? { model: flashModel, id: flashId } : null;
  }

  function cheapModel(ctx: any): { model: any; id: string } {
    const f = resolveFlash(ctx);
    if (f) return f;
    const t = tiers[0];
    const m = ctx.modelRegistry.find(t.provider, t.id);
    if (!m) throw new Error(`[router] ${t.id} not found`);
    return { model: m, id: t.id };
  }

  function planModel(ctx: any): { model: any; id: string } {
    const t = tiers[lastIdx];
    const m = ctx.modelRegistry.find(t.provider, t.id);
    if (!m) throw new Error(`[router] ${t.id} not found`);
    return { model: m, id: t.id };
  }

  function tierModel(ctx: any, idx: number): { model: any; id: string } {
    const t = tiers[Math.max(0, Math.min(idx, lastIdx))];
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
      const state: RouterState = request.state ?? { phase: "plan", tier: lastIdx };

      if (request.reason === "direct") {
        const sticky = request.failed ?? request.previous;
        if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "off" };
        const { model, id } = planModel(ctx);
        setStatus(id, state.phase, "direct");
        return { model, thinkingLevel: "off" };
      }

      if (request.reason === "retry") {
        const nextTier = Math.min(state.tier + 1, lastIdx);
        const { model, id } = tierModel(ctx, nextTier);
        setStatus(id, state.phase, "retry↑");
        return { model, thinkingLevel: "off", state: { ...state, tier: nextTier } };
      }

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
        if (!isTrivial(request.messages)) {
          const { model, id } = planModel(ctx);
          setStatus(id, "plan", "plan");
          return { model, thinkingLevel: "off", state: { ...state, tier: lastIdx } };
        }
        const { model, id } = cheapModel(ctx);
        setStatus(id, "plan", "trivial");
        return { model, thinkingLevel: "off", state: { ...state, tier: 0 } };
      }

      if (request.thinkingLevel && request.thinkingLevel !== "off") {
        const tierIdx = request.thinkingLevel === "low"
          ? 0
          : request.thinkingLevel === "medium"
          ? Math.floor(lastIdx / 2)
          : lastIdx;
        const { model, id } = tierModel(ctx, tierIdx);
        setStatus(id, "plan", "manual");
        return { model, thinkingLevel: "off", state: { phase: "plan", tier: tierIdx } };
      }

      if (isTrivial(request.messages)) {
        const { model, id } = cheapModel(ctx);
        setStatus(id, "plan", "trivial");
        return { model, thinkingLevel: "off", state: { phase: "plan", tier: 0 } };
      }

      const { model, id } = planModel(ctx);
      setStatus(id, "plan", "plan");
      return { model, thinkingLevel: "off", state: { phase: "plan", tier: lastIdx } };
    },
  });
}
