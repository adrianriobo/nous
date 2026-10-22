---
type: Agent
title: nous
description: Production-ready pi coding agent with Vertex AI and smart model routing.
tags: [agent, pi, vertex-ai, coding]
---

# nous

nous is a production-ready coding agent built on [pi](https://github.com/earendil-works/pi) with
Vertex AI integration. It automatically selects the right Claude model for each task:

- **Opus 4.6** for plan-phase turns (default)
- **Haiku** for trivial queries and mechanical implementation
- **Sonnet** for retry escalation

## Key features

- Boot-time self-discovery of available Vertex AI models
- rtk-oss token compression for bash output (60–90% reduction)
- OKF 2.0 wiki integration via wiki_search, wiki_read, wiki_ingest
- DuckDuckGo web search
- Alibaba open-code-review in delegate mode
- MCP tool injection at startup
