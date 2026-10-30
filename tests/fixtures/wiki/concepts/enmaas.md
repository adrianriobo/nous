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

- `gpt-6.1-terra` (default plan phase)
- `rits/zai-org/glm-5-3` (strong open-weight tier)
- `gpt-5.4-mini` (retry escalation)
- `gemini-3.8-flash` (trivial queries, implement phase)
