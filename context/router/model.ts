import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";

// ── Candidate models ordered most-capable → least-capable ─────────────────────
// discoverTiers() probes Vertex AI at boot and builds a live tier array from
// whatever is actually accessible in the project. The fallback (FALLBACK_TIERS)
// is used when discovery fails (no credentials yet, network unavailable, etc.).

export type Tier = { provider: string; id: string };

const VERTEX_CANDIDATES: Tier[] = [
  { provider: "vertex-anthropic", id: "claude-opus-4-6" },           // $5/1M
  { provider: "vertex-anthropic", id: "claude-opus-4-5@20251101" },  // $15/1M
  { provider: "vertex-anthropic", id: "claude-sonnet-4-5@20250929" },// $3/1M
  { provider: "vertex-anthropic", id: "claude-haiku-4-5@20251001" }, // $1/1M
];

// Fallback used when discovery cannot run (no creds, timeout, etc.)
export const FALLBACK_TIERS: Tier[] = [
  { provider: "vertex-anthropic", id: "claude-haiku-4-5@20251001" },
  { provider: "vertex-anthropic", id: "claude-sonnet-4-5@20250929" },
  { provider: "vertex-anthropic", id: "claude-opus-4-6" },
];

export const GEMINI_FLASH_CANDIDATES: Tier[] = [
  { provider: "google-vertex", id: "gemini-2.0-flash-001" },
  { provider: "google-vertex", id: "gemini-2.0-flash" },
  { provider: "google-vertex", id: "gemini-2.0-flash-exp" },
  { provider: "google-vertex", id: "gemini-2.0-flash-lite-001" },
  { provider: "google-vertex", id: "gemini-1.5-flash-001" },
  { provider: "google-vertex", id: "gemini-1.5-flash" },
];

// ── Boot-time model discovery ──────────────────────────────────────────────────

async function getVertexToken(): Promise<string> {
  // Try credential paths in priority order
  const paths = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    `${process.env.HOME}/.config/gcloud/application_default_credentials.json`,
    "/sandbox/.config/gcloud/application_default_credentials.json",
  ].filter(Boolean) as string[];

  for (const p of paths) {
    try {
      const cred = JSON.parse(readFileSync(p, "utf8"));
      if (cred.type === "authorized_user" && cred.refresh_token) {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: cred.client_id,
            client_secret: cred.client_secret,
            refresh_token: cred.refresh_token,
            grant_type: "refresh_token",
          }),
          signal: AbortSignal.timeout(5_000),
        });
        const data = await res.json() as any;
        if (data.access_token) return data.access_token;
      }
    } catch { /* try next path */ }
  }
  throw new Error("no usable ADC credentials found");
}

// Probe all VERTEX_CANDIDATES in parallel and return those that respond non-404.
// Results are sorted cheapest → most-capable (ascending) so index 0 = cheap,
// index N-1 = best — matching the tier convention used by the router.
export async function discoverTiers(): Promise<Tier[]> {
  const project =
    process.env.ANTHROPIC_VERTEX_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT;
  const region =
    process.env.CLOUD_ML_REGION ||
    process.env.VERTEX_LOCATION ||
    "us-east5";

  if (!project) {
    process.stderr.write("[nous] router: no GCP project configured — using fallback tiers\n");
    return FALLBACK_TIERS;
  }

  let token: string;
  try {
    token = await getVertexToken();
  } catch (e: any) {
    process.stderr.write(`[nous] router: token fetch failed (${e.message}) — using fallback tiers\n`);
    return FALLBACK_TIERS;
  }

  const host = region === "global"
    ? "aiplatform.googleapis.com"
    : `${region}-aiplatform.googleapis.com`;

  const probes = await Promise.allSettled(
    VERTEX_CANDIDATES.map(async (c) => {
      const url = `https://${host}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${c.id}:streamRawPredict`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          anthropic_version: "vertex-2023-10-16",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      return { tier: c, available: res.status !== 404 };
    })
  );

  // Keep available models in original candidate order (most → least capable),
  // then reverse so index 0 = cheapest (tier 0) and last = best (plan default).
  const available: Tier[] = probes
    .filter((r): r is PromiseFulfilledResult<{ tier: Tier; available: boolean }> =>
      r.status === "fulfilled" && r.value.available
    )
    .map((r) => r.value.tier)
    .reverse();

  if (available.length === 0) {
    process.stderr.write("[nous] router: no models confirmed — using fallback tiers\n");
    return FALLBACK_TIERS;
  }

  process.stderr.write(
    `[nous] router: discovered tiers — ${available.map((t, i) => `[${i}]${t.id}`).join(", ")}\n`
  );
  return available;
}

// ── Routing helpers ────────────────────────────────────────────────────────────

const LEVEL_TO_TIER_OFFSET: Record<string, number> = {
  off: -1,  // -1 means "use planModel (last tier)"
  low: 0,
  medium: -2, // second-to-last
  high: -1,   // last (best)
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
