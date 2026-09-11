# Agent topology — haropz

This document describes the agent architecture, routing rules, and token
optimisation strategy for the haropz OCI image.

## Overview

```
omnigent (router)
├── pi-haiku   — Claude Haiku 4.5    — simple, fast, cheapest
├── pi-sonnet  — Claude Sonnet 4.5   — balanced capability / cost
└── pi-opus    — Claude Opus 4.6     — highest capability, most expensive
```

All three agents share the same `pi` CLI harness from the base image.  The
router selects the tier and injects `--model <id>` before dispatching.

---

## Agents

### pi-haiku

| Property | Value |
|---|---|
| Model | `claude-haiku-4-5@20251001` |
| Max tokens | 4 096 |
| Use for | Simple queries, factual lookups, short completions, formatting, translation |
| Self-assess | Yes — escalates to pi-sonnet if it returns NO |

**When to target directly:**

```bash
omnigent --tier haiku --task "Translate this sentence to French"
```

---

### pi-sonnet

| Property | Value |
|---|---|
| Model | `claude-sonnet-4-5@20250929` |
| Max tokens | 16 384 |
| Use for | Code review, debugging, test generation, medium refactors, documentation |
| Self-assess | Yes — escalates to pi-opus if it returns NO |

**When to target directly:**

```bash
omnigent --tier sonnet --task "Review this PR diff for correctness"
```

---

### pi-opus

| Property | Value |
|---|---|
| Model | `claude-opus-4-6` |
| Max tokens | 32 768 |
| Use for | Architecture decisions, complex reasoning, long-context tasks, security reviews, multi-file refactors |
| Self-assess | No — this is the final escalation tier; it always runs |

**When to target directly:**

```bash
omnigent --tier opus --task "Design a distributed caching strategy"
```

---

## Routing algorithm

```
1. Classify task → match against trigger keywords in config.
2. Pick the lowest tier whose trigger list matches.
3. If skip_self_assess=false: ask that model "can you handle this? YES/NO".
   - YES → dispatch to that tier.
   - NO  → move to next tier, repeat from step 3.
4. If no tier accepts, dispatch to pi-opus unconditionally.
5. On model error (rate-limit, context overflow): escalate one tier, then fail.
```

### Escalation path

```
pi-haiku → pi-sonnet → pi-opus → error
```

The router never de-escalates within a single task.

---

## Token optimisation strategy

| Technique | Description |
|---|---|
| Tier selection | Use the cheapest model whose capability profile fits |
| Self-assessment | Models refuse tasks they cannot handle, preventing expensive retries |
| Max-token caps | Per-tier caps prevent runaway responses |
| Session budget | Configurable hard cap stops unbounded spend (see `omnigent.yaml`) |
| OTel metrics | `haropz.tokens.input`, `haropz.tokens.output`, `haropz.tier.selected` exported for dashboarding |

---

## Adding a new agent

1. Add an entry under `agents:` in `config/omnigent.yaml`.
2. List the unique trigger keywords for this tier.
3. Determine its position in the escalation order (cheapest first).
4. If it is a new model family, update the model ID in this file; for hermetic
   builds pre-fetch the wheel and update the pip install layer in Containerfile.
5. Add a structure-test assertion in `tests/structure-test.yaml`.

---

## Environment variables consumed by agents

| Variable | Used by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | pi harness | Anthropic direct auth |
| `GOOGLE_APPLICATION_CREDENTIALS` | pi harness | Path to GCP service account JSON (Vertex AI) |
| `GOOGLE_CLOUD_PROJECT` | pi harness | GCP project ID (Vertex AI) |
| `GOOGLE_CLOUD_LOCATION` | pi harness | GCP region (Vertex AI) |
| `OMNIGENT_CONFIG_HOME` | router | Directory containing `config.yaml` (default: `/sandbox/.omnigent`) |
| `LOG_LEVEL` | router | Routing trace verbosity |
| `OTEL_ENABLED` | router | Token-usage metric export |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | router | Collector address |

---

## Observability

When `OTEL_ENABLED=true` the router emits:

| Metric | Type | Labels |
|---|---|---|
| `haropz.tokens.input` | counter | `tier`, `model` |
| `haropz.tokens.output` | counter | `tier`, `model` |
| `haropz.tier.selected` | counter | `tier`, `reason` |
| `haropz.escalations.total` | counter | `from_tier`, `to_tier` |
| `haropz.task.latency_ms` | histogram | `tier` |
