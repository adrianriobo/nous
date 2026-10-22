---
type: Platform
title: Vertex AI
description: Google Cloud managed AI platform used by nous for model inference.
tags: [gcp, vertex-ai, llm, anthropic]
resource: https://cloud.google.com/vertex-ai
---

# Vertex AI

Vertex AI is Google Cloud's managed machine learning platform. nous uses it to access
Anthropic Claude models via the `pi-provider-vertex-anthropic` provider.

## Configuration

Set these environment variables to connect nous to Vertex AI:

- `ANTHROPIC_VERTEX_PROJECT_ID` — your GCP project ID
- `CLOUD_ML_REGION` — region, e.g. `us-east5` or `global`

## Supported models

nous probes these models at boot time and uses whichever are available:

- `claude-opus-4-6` (default plan phase)
- `claude-sonnet-4-5@20250929` (retry escalation)
- `claude-haiku-4-5@20251001` (trivial queries, implement phase)
