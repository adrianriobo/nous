---
type: Agent
title: nous
description: Production-ready pi coding agent with EnMaaS and smart model routing.
tags: [agent, pi, enmaas, coding]
---

# nous

nous is a production-ready coding agent built on [pi](https://github.com/earendil-works/pi) with
EnMaaS integration. It automatically selects the right model for each task:

- **GPT 6.1 Terra** for plan-phase turns (default)
- **Gemini 3.8 Flash** for trivial queries and mechanical implementation
- **GPT 5.4 Mini** and **GLM 5.3** for retry escalation

## Key features

- Boot-time self-discovery of available EnMaaS models
- rtk-oss token compression for bash output (60–90% reduction)
- OKF 2.0 wiki integration via wiki_search, wiki_read, wiki_ingest
- DuckDuckGo web search
- Alibaba open-code-review in delegate mode
- MCP tool injection at startup
