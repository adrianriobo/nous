import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";

// ── EnMaaS gateway ────────────────────────────────────────────────────────────
// EnMaaS is the internal Models-as-a-Service gateway. It exposes an
// OpenAI-compatible API, so pi's built-in "openai-completions" implementation
// handles streaming, tools, and usage accounting. No custom provider code is
// needed — this module only registers the endpoint, declares the model
// catalog, and discovers live routing tiers at boot.

export const PROVIDER_ID = "enmaas";
export const DEFAULT_BASE_URL = "https://api.enmaas.devshift.net/v1";

// ENMAAS_BASE_URL overrides the endpoint (integration tests, mirrors).
export function resolveBaseUrl(): string {
  const override = process.env.ENMAAS_BASE_URL?.trim();
  return override ? override.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

export type Tier = { provider: string; id: string };

// ── Model catalog ─────────────────────────────────────────────────────────────
// Full catalog served by the gateway. Costs are zero: usage is metered by the
// gateway (PriceTag), not through pi. Add new gateway models here; they become
// selectable with `--model enmaas/<id>` without further configuration.

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function m(
  id: string,
  name: string,
  reasoning: boolean,
  contextWindow: number,
  maxTokens: number,
  compat?: Record<string, unknown>,
) {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    cost: COST,
    contextWindow,
    maxTokens,
    ...(compat ? { compat } : {}),
  };
}

// Open-weight models reject the developer role — send system instead.
const NO_DEVELOPER_ROLE = { supportsDeveloperRole: false };

const CATALOG = [
  // OpenAI family
  m("gpt-6.1-terra", "GPT 6.1 Terra (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-6.1-sol", "GPT 6.1 Sol (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-6-astra", "GPT 6 Astra (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-6-sol", "GPT 6 Sol (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-6-luna", "GPT 6 Luna (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.6-terra", "GPT 5.6 Terra (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.6-sol", "GPT 5.6 Sol (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.6-luna", "GPT 5.6 Luna (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.5", "GPT 5.5 (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.4", "GPT 5.4 (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.4-mini", "GPT 5.4 Mini (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.4-nano", "GPT 5.4 Nano (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5.3-codex", "GPT 5.3 Codex (EnMaaS)", true, 1_048_576, 65_536),
  m("gpt-5-mini", "GPT 5 Mini (EnMaaS)", true, 131_072, 16_384),
  m("gpt-4o-mini", "GPT 4o mini (EnMaaS)", false, 131_072, 16_384),
  m("codex-auto-review", "Codex Auto Review (EnMaaS)", false, 1_048_576, 65_536),
  // Gemini family
  m("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview (EnMaaS)", true, 1_048_576, 65_536),
  m("gemini-3.8-flash", "Gemini 3.8 Flash (EnMaaS)", true, 1_048_576, 65_536),
  m("gemini-3.7-flash", "Gemini 3.7 Flash (EnMaaS)", true, 1_048_576, 65_536),
  m("gemini-3.6-flash", "Gemini 3.6 Flash (EnMaaS)", true, 1_048_576, 65_536),
  // Open-weight family
  m("rits/zai-org/glm-5-3", "GLM 5.3 (EnMaaS)", true, 1_048_576, 65_536, NO_DEVELOPER_ROLE),
  m("rits/deepseek-ai/DeepSeek-V4.1-Flash-1017", "DeepSeek V4.1 Flash (EnMaaS)", false, 131_072, 16_384, NO_DEVELOPER_ROLE),
];

// ── Routing tiers ─────────────────────────────────────────────────────────────
// Candidates ordered cheapest → most-capable. discoverTiers() keeps only the
// models the gateway confirms and preserves this order, so index 0 = cheap
// (implement phase) and the last entry = best (plan-phase default).

export const TIER_CANDIDATES: Tier[] = [
  { provider: PROVIDER_ID, id: "gemini-3.8-flash" },      // cheap, fast
  { provider: PROVIDER_ID, id: "gpt-5.4-mini" },          // mid tier
  { provider: PROVIDER_ID, id: "rits/zai-org/glm-5-3" },  // strong open-weight
  { provider: PROVIDER_ID, id: "gpt-6.1-terra" },         // best — plan default
];

// Used when discovery cannot run (no key, network unavailable, timeout).
export const FALLBACK_TIERS: Tier[] = TIER_CANDIDATES;

// Flash models preferred for the implement phase (cheapest usable turns).
export const FLASH_CANDIDATES: Tier[] = [
  { provider: PROVIDER_ID, id: "gemini-3.8-flash" },
  { provider: PROVIDER_ID, id: "gemini-3.7-flash" },
  { provider: PROVIDER_ID, id: "gemini-3.6-flash" },
];

// ── Boot-time model discovery ──────────────────────────────────────────────────

function resolveApiKey(): string | undefined {
  const env = process.env.ENMAAS_API_KEY?.trim();
  if (env) return env;
  // Fall back to a stored credential (pi /login) keyed by provider id.
  try {
    const authPath = `${process.env.HOME}/.pi/agent/auth.json`;
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const entry = auth[PROVIDER_ID];
    if (entry?.type === "api_key" && typeof entry.key === "string") return entry.key;
  } catch { /* no auth.json — env var only */ }
  return undefined;
}

// Probe GET /v1/models on the gateway and keep the candidates it lists.
export async function discoverTiers(): Promise<Tier[]> {
  const key = resolveApiKey();

  if (!key) {
    process.stderr.write("[nous] router: no EnMaaS API key — using fallback tiers\n");
    return FALLBACK_TIERS;
  }

  try {
    const res = await fetch(`${resolveBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const ids = new Set<string>((data.data ?? data.models ?? []).map((x: any) => x.id));

    const available = TIER_CANDIDATES.filter((c) => ids.has(c.id));
    if (available.length === 0) {
      process.stderr.write("[nous] router: gateway lists no tier candidates — using fallback tiers\n");
      return FALLBACK_TIERS;
    }

    process.stderr.write(
      `[nous] router: discovered tiers — ${available.map((t, i) => `[${i}]${t.id}`).join(", ")}\n`
    );
    return available;
  } catch (e: any) {
    process.stderr.write(`[nous] router: gateway discovery failed (${e.message}) — using fallback tiers\n`);
    return FALLBACK_TIERS;
  }
}

// ── Provider registration ──────────────────────────────────────────────────────

export function registerEnmaasProvider(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "EnMaaS",
    baseUrl: resolveBaseUrl(),
    apiKey: "$ENMAAS_API_KEY",
    api: "openai-completions",
    models: CATALOG,
  });
}
