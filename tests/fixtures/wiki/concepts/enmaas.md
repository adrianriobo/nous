---
type: Platform
title: EnMaaS
description: Internal Models-as-a-Service AI gateway used by nous for model inference.
tags: [redhat, enmaas, llm, gateway]
---

# EnMaaS

EnMaaS is the internal Models-as-a-Service AI gateway. nous uses it to access
frontier and open-weight models through the OpenAI-compatible completions API.

## Configuration

Set these environment variables to connect nous to EnMaaS:

- `ENMAAS_API_KEY` — API key for the gateway
- `ENMAAS_BASE_URL` — gateway base URL (default `https://api.enmaas.devshift.net/v1`)

## Supported models

nous probes the gateway at boot time and routes to whichever tier candidates
are available:

- `rits/zai-org/glm-5-3` (default plan phase, free hosted model)
- `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` (trivial queries, implement phase, free hosted model)
- `gpt-5.4-mini` and `gpt-6.1-terra` (retry escalation only, paid)
