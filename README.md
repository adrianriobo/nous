<p align="center">
  <img src="assets/nous-logo.svg" alt="nous" width="140"/>
</p>

<h1 align="center">nous</h1>

<p align="center">A production-ready <a href="https://github.com/earendil-works/pi">pi</a> coding agent with EnMaaS, built for secure enterprise environments.</p>

## What you get

**Smart model routing** — automatically picks the right model for each task. Default is GLM 5.3 (free hosted model) for plan-phase turns; DeepSeek V4.1 Flash (free) for trivial queries and mechanical implementation. Paid frontier models serve retry escalation only. Available models are self-discovered from the EnMaaS gateway at boot — no configuration needed.

**Web search** — DuckDuckGo search built in. The agent searches the web when it needs current information without you having to ask.

**AI code review** — powered by [Alibaba open-code-review](https://github.com/alibaba/open-code-review). Point it at a GitHub PR and it gives you structured, rule-based feedback.

**Personal knowledge wiki** — mount an [OKF 2.0](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) wiki (e.g. an Obsidian vault processed by an LLM-wiki agent) and nous gains three tools: `wiki_search`, `wiki_read`, and `wiki_ingest`. The agent searches your curated knowledge base before reaching for the web, and can feed new content into the wiki pipeline via `raw/assets/`.

**Token compression** — [rtk-oss](https://github.com/rtk-ai/rtk) (Apache-2.0) compresses bash tool output before pi reads it, cutting 60–90% of tokens on large command outputs. Installed and registered automatically at build time.

**Kernel-level egress control** — runs inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell), which enforces network policy at the kernel level. The agent can only reach what you explicitly allow.

**Productization skills** — the `nous-productization` image extends the base image with [productization-skills](https://github.com/opendatahub-io/productization-skills): 18 pi-native skills for Jira, GitLab, Konflux, Google Workspace, Slack, and more, plus the tool CLIs they depend on (`gh`, `glab`, `jq`, `yq`, `kubectl`, `kustomize`, `tkn`, `uv`, …). All installed at build time — no runtime setup.

## Image variants

| Image | Tag | Contents |
|---|---|---|
| `ghcr.io/aipcc/nous` | `latest` / `<sha>` / `<version>` | Router, web search, code review, wiki tools (when mounted), rtk token compression |
| `ghcr.io/aipcc/nous-productization` | `<skills-ref>-<nous-version>` / `latest` | Base + 18 skills + tool CLIs + Python 3.12 |

Both are built from the same `Containerfile` using named targets (`--target nous` / `--target nous-productization`). The productization tag encodes both sides — e.g. `0.9.1-0.3.0` means skills `v0.9.1` on top of nous `v0.3.0`. Renovate tracks the skills release and bumps `SKILLS_REF` automatically.

## Quick start

```bash
# Base image — interactive
podman run --rm -it \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest

# Productization image — with Jira/GitLab/Konflux skills
podman run --rm -it \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous-productization:latest

# Or pipe a task
echo 'Review PR https://github.com/OWNER/REPO/pull/42' | \
  podman run --rm -i \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest
```

## Personal knowledge wiki

Mount an [OKF 2.0](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) wiki at `/sandbox/wiki` and nous gains three tools automatically:

```bash
podman run --rm -it \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  -v /path/to/your/obsidian-vault:/sandbox/wiki:z \
  ghcr.io/aipcc/nous:latest
```

| Tool | What it does |
|---|---|
| `wiki_search` | Scores pages by match in title, description, tags, and body — returns excerpts |
| `wiki_read` | Reads a full wiki page by its relative path |
| `wiki_ingest` | Writes new content to `raw/assets/` for the processor agent to pick up |

The wiki follows the [LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): an `index.md` catalog, a `log.md` history, OKF concept pages, and a `raw/` directory of immutable source documents. nous reads the wiki pages and can feed new content into the pipeline via `raw/assets/` — it never writes wiki pages directly.

Override the default mount path with `WIKI_PATH` if needed.

## Common agent conventions

The image bakes common agent conventions into `/sandbox/.pi/agent/APPEND_SYSTEM.md`. These apply to every nous deployment and every task-specific `AGENTS.md` file you provide:

| Convention | What it specifies |
|---|---|
| ASD-STE100 | Communication standard for all agent output (conversational replies, commit messages, MR descriptions, code comments, documentation) |
| Work locations | `/workspace` for all repository work; `/sandbox/AGENTS.md` for task instructions; `/sandbox/wiki/` for knowledge base |
| Git identity | Pre-configured name and email for all commits |
| Startup procedure | Search the wiki first before starting any task; read matching pages; check `/workspace` for prior artifacts |
| Code review | Always run `code_review` (OCR rule engine) first when reviewing PRs or MRs; then apply LLM analysis on top |

Task-specific `AGENTS.md` files you mount at `/sandbox/AGENTS.md` define your role, goal, repositories, and responsibilities. Pi loads both the common conventions and your task-specific instructions without conflict.

## Credentials

nous needs two env vars and Google credentials:

| Variable | Description |
|---|---|
| `ENMAAS_API_KEY` | EnMaaS gateway API key |
| `ENMAAS_BASE_URL` | EnMaaS gateway base URL. **Required** — there is no default. Set it in your environment |

For credentials, mount your ADC file (shown above) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON path.

## Internal CA bundles

If your MCP servers or internal services use a private CA, mount the bundle at startup:

```bash
-v /path/to/ca-bundle.crt:/run/secrets/ca-bundle.crt:z
```

nous exports `NODE_EXTRA_CA_CERTS` automatically so all Node.js traffic trusts the bundle — no root access required. If you set `NODE_EXTRA_CA_CERTS` in your env file, that value takes precedence.

## External MCP servers

Mount an `mcp.json` to inject additional MCP servers at startup:

```bash
-v /path/to/mcp.json:/run/secrets/mcp.json:z
```

The file follows the standard MCP format:

```json
{
  "mcpServers": {
    "my_server": {
      "url": "https://my-mcp-server.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

At startup nous merges these entries into the agent's MCP config, calls `tools/list` on each HTTP server, and registers every discovered tool as a first-class pi function named `<serverName>_<toolName>`. The discovery runs before pi initialises so the tools appear in pi's `<functions>` block from the first turn — no image rebuild required, no codemode needed.

Both MCP transport protocols are supported automatically:
- **Streamable HTTP** (MCP spec 2025-03-26) — direct POST with session negotiation via `Mcp-Session-Id`
- **HTTP+SSE** (MCP spec 2024-11-05) — GET-based SSE stream with a separate message endpoint

### Routing

nous reads the `instructions` field from each server's `initialize` response and prepends it to every tool description. pi uses this to prefer domain-specific tools over `web_search` without any extra configuration.

To override or sharpen the routing signal, add a `hint` field alongside the server URL:

```json
{
  "mcpServers": {
    "my_server": {
      "url": "https://my-mcp-server.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "hint": "Use for any questions about <your domain>"
    }
  }
}
```

The `hint` takes precedence over the server's own `instructions`. No rebuild needed — change the mounted `mcp.json` and restart the container.

## Build your own

```bash
git clone https://github.com/aipcc/nous
make build
```

## Go deeper

| Topic | Doc |
|---|---|
| Running with podman and OpenShell | [docs/running.md](docs/running.md) |
| CI/CD workflows and mock EnMaaS server | [docs/ci.md](docs/ci.md) |
| Router logic, model tiers, tools, egress architecture | [AGENTS.md](AGENTS.md) |
