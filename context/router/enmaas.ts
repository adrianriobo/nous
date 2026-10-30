import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";

// ── EnMaaS gateway ────────────────────────────────────────────────────────────
// EnMaaS is the internal Models-as-a-Service gateway. It exposes an
// OpenAI-compatible API, so pi's built-in "openai-completions" implementation
// handles streaming, tools, and usage accounting. No custom provider code is
// needed — this module only registers the endpoint, declares the model
// catalog, and discovers live routing tiers at boot.

export const PROVIDER_ID = "enmaas";

// The gateway endpoint is internal. It has no default in this repository —
// set ENMAAS_BASE_URL in your environment (for example in your shell profile
// or the container env). The value must point at the OpenAI-compatible base
// URL of the gateway.
export function resolveBaseUrl(): string {
  const url = process.env.ENMAAS_BASE_URL?.trim();
  return url ? url.replace(/\/+$/, "") : "";
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
  extra?: Record<string, unknown>,
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
    ...(extra ? extra : {}),
  };
}

// Open-weight models reject the developer role — send system instead.
const NO_DEVELOPER_ROLE = { supportsDeveloperRole: false };

// OpenAI-family models must use the Responses API on this gateway. Chat
// completions rejects function tools combined with any reasoning_effort
// other than 'none' — and rejects a missing reasoning_effort too, because
// the model default is non-none. Since a coding agent always sends tools,
// /v1/responses is the only dialect that supports tools and reasoning
// together for these models (verified against the gateway).
const RESPONSES = { api: "openai-responses" };

const CATALOG = [
  // OpenAI family
  m("gpt-6.1-terra", "GPT 6.1 Terra (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-6.1-sol", "GPT 6.1 Sol (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-6-astra", "GPT 6 Astra (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-6-sol", "GPT 6 Sol (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-6-luna", "GPT 6 Luna (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.6-terra", "GPT 5.6 Terra (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.6-sol", "GPT 5.6 Sol (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.6-luna", "GPT 5.6 Luna (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.5", "GPT 5.5 (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.4", "GPT 5.4 (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.4-mini", "GPT 5.4 Mini (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.4-nano", "GPT 5.4 Nano (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5.3-codex", "GPT 5.3 Codex (EnMaaS)", true, 1_048_576, 65_536, undefined, RESPONSES),
  m("gpt-5-mini", "GPT 5 Mini (EnMaaS)", true, 131_072, 16_384, undefined, RESPONSES),
  m("gpt-4o-mini", "GPT 4o mini (EnMaaS)", false, 131_072, 16_384, undefined, RESPONSES),
  m("codex-auto-review", "Codex Auto Review (EnMaaS)", false, 1_048_576, 65_536, undefined, RESPONSES),
  // Gemini family. NOTE: gateway testing showed gemini chat-completions
  // rejects the standard nested tool format ("Expected input to contain
  // field: 'function'"). These entries stay catalog-only until the correct
  // dialect is confirmed — the router never selects them.
  m("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview (EnMaaS)", true, 1_048_576, 65_536),
  m("gemini-3.8-flash", "Gemini 3.8 Flash (EnMaaS)", true, 1_048_576, 65_536),
  m("gemini-3.7-flash", "Gemini 3.7 Flash (EnMaaS)", true, 1_048_576, 65_536),
  m("gemini-3.6-flash", "Gemini 3.6 Flash (EnMaaS)", true, 1_048_576, 65_536),
  // Open-weight family
  // Hosted model, free of charge. Context window must not exceed 1,000,000
  // (gateway limit). Penalties must stay 0: non-zero values make GLM drift
  // into Chinese.
  m("rits/zai-org/glm-5-3", "GLM 5.3 (EnMaaS)", true, 1_000_000, 65_536, NO_DEVELOPER_ROLE, {
    samplingParams: { frequency_penalty: 0, presence_penalty: 0 },
  }),
  // Hosted model, free of charge. Do not copy GLM context-window, penalty,
  // or capability settings here.
  m("rits/deepseek-ai/DeepSeek-V4.1-Flash-1017", "DeepSeek V4.1 Flash (EnMaaS)", false, 128_000, 16_384, NO_DEVELOPER_ROLE),
];

// ── Routing tiers ─────────────────────────────────────────────────────────────
// Candidates ordered cheapest → most-capable. The gateway hosts GLM 5.3 and
// DeepSeek V4.1 Flash free of charge, so they take the bottom tiers and the
// plan-phase default. Paid frontier models serve only as retry escalation or
// manual `--model` selection. This keeps monthly spend near zero under the
// strict budget limit.

// Hosted models are pinned locally: the /v1/models response is
// credential-dependent and can omit them even when inference works.
export const HOSTED_MODEL_IDS = new Set([
  "rits/zai-org/glm-5-3",
  "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
]);

export const TIER_CANDIDATES: Tier[] = [
  { provider: PROVIDER_ID, id: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" }, // free, fast
  { provider: PROVIDER_ID, id: "rits/zai-org/glm-5-3" },                      // free — plan default
  { provider: PROVIDER_ID, id: "gpt-5.4-mini" },                              // paid — escalation
  { provider: PROVIDER_ID, id: "gpt-6.1-terra" },                             // paid — escalation, manual high
];

// Used when discovery cannot run (no key, network unavailable, timeout).
export const FALLBACK_TIERS: Tier[] = TIER_CANDIDATES;

// Cheap candidates preferred for the implement phase. Free hosted models
// only: gemini chat-completions rejects the standard tool format on this
// gateway, so the router never routes to gemini (see catalog note above).
export const CHEAP_CANDIDATES: Tier[] = [
  { provider: PROVIDER_ID, id: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017" },
  { provider: PROVIDER_ID, id: "rits/zai-org/glm-5-3" },
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
  if (!resolveBaseUrl()) {
    process.stderr.write("[nous] router: ENMAAS_BASE_URL not set — using fallback tiers\n");
    return FALLBACK_TIERS;
  }

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

    // Keep a candidate when the gateway lists it, or when it is a pinned
    // hosted model (the catalog is credential-dependent and can omit those).
    const available = TIER_CANDIDATES.filter((c) => ids.has(c.id) || HOSTED_MODEL_IDS.has(c.id));
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
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    // The entrypoint blocks this state, but direct `pi` runs can reach it.
    // Register against a .invalid host so any request fails fast with a
    // clear cause instead of hitting a real endpoint.
    process.stderr.write(
      "[nous] enmaas: ENMAAS_BASE_URL is not set — set it to the gateway base URL.\n"
    );
  }
  pi.registerProvider(PROVIDER_ID, {
    name: "EnMaaS",
    baseUrl: baseUrl || "http://enmaas-base-url-not-set.invalid/v1",
    apiKey: "$ENMAAS_API_KEY",
    api: "openai-completions",
    models: CATALOG,
  });
}
