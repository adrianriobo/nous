import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHEAP_CANDIDATES, PLAN_CANDIDATES, type Tier } from "./enmaas.ts";

// Automatic routing starts with hosted models. A paid model is an escalation.
// Escalation needs no dialog, so it works in print and other non-interactive
// modes. Set NOUS_PAID_ESCALATION=off to keep automatic routing on hosted
// models. A manual tier or model selection can always use a paid model.
type Phase = "plan" | "implement";
type RouterState = { phase: Phase; tier: number };
type Selected = { model: any; id: string; index: number };

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

const DESIGN_PATTERN =
  /architecture|refactor|migrat|design|security review|performance|across the (repo|codebase)|multi-file|end.to.end|root cause/i;
const FILE_PATTERN = /[\w./-]+\.(?:ts|tsx|js|mjs|cjs|py|go|rs|java|ya?ml|json|md|sh|tf)\b/gi;

export function isVeryComplex(messages: readonly any[]): boolean {
  const text = lastUserText(messages);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const files = new Set((text.match(FILE_PATTERN) ?? []).map((name) => name.toLowerCase())).size;
  return (words >= 120 && DESIGN_PATTERN.test(text)) || (words >= 60 && files >= 4);
}

export function hasWritten(messages: readonly any[]): boolean {
  // Inspect only the current user turn. Historical tool calls must not change
  // a new planning request into an implementation continuation.
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  return messages.slice(lastUser + 1).some((m) => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some((b: any) => {
      const name = b.name ?? "";
      return (b.type === "toolCall" || b.type === "tool_use") && /^(edit|write|bash|create|patch)$/.test(name);
    });
  });
}

/** Automatic escalation to paid models. `auto` is the default; `off` disables it. */
export function paidEscalation(): boolean {
  const value = (process.env.NOUS_PAID_ESCALATION ?? "auto").trim().toLowerCase();
  return !["off", "0", "false", "no", "never"].includes(value);
}

export function registerRouter(pi: ExtensionAPI, tiers: Tier[]) {
  if (tiers.length === 0) throw new Error("[router] No model tiers are configured.");
  const lastIdx = tiers.length - 1;
  const escalate = paidEscalation();

  function getTier(ctx: any, index: number): Selected | null {
    const tier = tiers[index];
    if (!tier) return null;
    const model = ctx.modelRegistry.find(tier.provider, tier.id);
    return model ? { model, id: tier.id, index } : null;
  }

  function selectCandidates(ctx: any, candidates: readonly Tier[]): Selected | null {
    for (const candidate of candidates) {
      const index = tiers.findIndex((tier) => tier.provider === candidate.provider && tier.id === candidate.id);
      const selected = getTier(ctx, index);
      if (selected) return selected;
    }
    return null;
  }

  function requireHosted(ctx: any, candidates: readonly Tier[]): Selected {
    const selected = selectCandidates(ctx, candidates);
    if (!selected) throw new Error("[router] No hosted model is available for automatic routing.");
    return selected;
  }

  function requireTier(ctx: any, index: number): Selected {
    const selected = getTier(ctx, index);
    if (!selected) throw new Error(`[router] The selected model tier ${index} is unavailable.`);
    return selected;
  }

  function isHosted(index: number): boolean {
    const tier = tiers[index];
    return !!tier && CHEAP_CANDIDATES.some((candidate) => candidate.provider === tier.provider && candidate.id === tier.id);
  }

  function nextPaid(ctx: any, after: number): Selected | null {
    for (let index = 0; index <= lastIdx; index++) {
      if (index <= after || isHosted(index)) continue;
      const selected = getTier(ctx, index);
      if (selected) return selected;
    }
    return null;
  }

  function indexOf(model: any): number {
    if (!model) return -1;
    return tiers.findIndex((tier) => tier.provider === model.provider && tier.id === model.id);
  }

  function setStatus(id: string, phase: Phase, reason: string) {
    pi.ui?.setStatus("router", `router → ${id} [${phase}] (${reason})`);
  }

  function result(selected: Selected, phase: Phase, reason: string) {
    setStatus(selected.id, phase, reason);
    return { model: selected.model, thinkingLevel: "off" as const, state: { phase, tier: selected.index } };
  }

  pi.registerVirtualModel<RouterState>({
    provider: "router",
    id: "auto",
    name: "Auto Router",
    thinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,

    route(request, ctx) {
      const state = request.state;
      const phase: Phase = state?.phase ?? "plan";

      if (request.reason === "direct") {
        const sticky = request.failed ?? request.previous;
        if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "off" };
        const selected = requireHosted(ctx, PLAN_CANDIDATES);
        setStatus(selected.id, "plan", "direct");
        return { model: selected.model, thinkingLevel: "off" };
      }

      if (request.reason === "retry") {
        const failedIndex = indexOf(request.failed?.model);
        const stateIndex = Number.isInteger(state?.tier) ? state!.tier : -1;
        const current = failedIndex >= 0 ? failedIndex : stateIndex;
        const manualSelection = !!request.thinkingLevel && request.thinkingLevel !== "off";

        if (current >= 0 && !isHosted(current)) {
          // A manually selected paid model retries itself. An automatic paid
          // model moves to a higher paid tier when one exists.
          if (manualSelection) return result(requireTier(ctx, current), phase, "retry");
          const higher = nextPaid(ctx, current);
          return result(higher ?? requireTier(ctx, current), phase, higher ? "retry↑ paid" : "retry paid");
        }

        for (let index = Math.max(current + 1, 0); index <= lastIdx; index++) {
          if (!isHosted(index)) continue;
          const selected = getTier(ctx, index);
          if (selected) return result(selected, phase, "retry↑");
        }

        // No hosted tier remains. Escalate to the first available paid tier.
        if (escalate) {
          const paid = nextPaid(ctx, current) ?? nextPaid(ctx, -1);
          if (paid) return result(paid, phase, "retry→paid");
        }
        if (current >= 0 && isHosted(current) && getTier(ctx, current)) {
          return result(requireTier(ctx, current), phase, "retry");
        }
        return result(requireHosted(ctx, PLAN_CANDIDATES), phase, "retry→hosted");
      }

      if (request.reason === "continuation" && request.previous) {
        if (phase === "plan" && hasWritten(request.messages)) {
          return result(requireHosted(ctx, CHEAP_CANDIDATES), "implement", "plan→implement");
        }
        if (phase === "implement") {
          return result(requireHosted(ctx, CHEAP_CANDIDATES), "implement", "implement");
        }
        // Keep the model that answered this turn. This preserves an explicitly
        // selected tier and avoids changing models after read-only tool calls.
        const previousIndex = indexOf(request.previous.model);
        if (previousIndex < 0) throw new Error("[router] The previous model is not in the configured tiers.");
        const selected = requireTier(ctx, previousIndex);
        setStatus(selected.id, phase, "continuation");
        return { model: selected.model, thinkingLevel: request.previous.thinkingLevel ?? "off", state: { phase, tier: selected.index } };
      }

      if (request.thinkingLevel && request.thinkingLevel !== "off") {
        const index = request.thinkingLevel === "low"
          ? 0
          : request.thinkingLevel === "medium" ? Math.floor(lastIdx / 2) : lastIdx;
        return result(requireTier(ctx, index), "plan", "manual");
      }

      if (isTrivial(request.messages)) {
        return result(requireHosted(ctx, CHEAP_CANDIDATES), "plan", "trivial");
      }

      if (escalate && isVeryComplex(request.messages)) {
        const paid = nextPaid(ctx, -1);
        if (paid) return result(paid, "plan", "complex→paid");
      }

      return result(requireHosted(ctx, PLAN_CANDIDATES), "plan", "plan");
    },
  });
}
