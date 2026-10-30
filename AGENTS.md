# nous — agent topology

## Image targets

The `Containerfile` defines two named targets published as **separate images**:

| Target | Image | Tag scheme | Description |
|---|---|---|---|
| `nous` | `ghcr.io/aipcc/nous` | `latest` / `<sha>` / `<version>` | Base pi harness — router, web search, code review |
| `nous-productization` | `ghcr.io/aipcc/nous-productization` | `<skills-ref>-<nous-version>` / `latest` | Extends `nous` with productization-skills and tool CLIs |

The productization tag encodes both versioned inputs independently — e.g. `v1.2.0-v0.3.0` means productization-skills tag `v1.2.0` installed on top of nous `v0.3.0`.

```bash
podman build --target nous              -t nous:latest .
podman build --target nous-productization -t nous-productization:latest .

# Pin a specific skills release
podman build --target nous-productization \
  --build-arg SKILLS_REF=v0.9.1 \
  -t nous-productization:0.9.1-0.3.0 .
```

The `nous-productization` target adds only one layer on top of `nous` (skills directory + binaries), so both share the same base cache and the productization build is fast.

## Architecture

nous wraps [pi](https://github.com/earendil-works/pi) with a TypeScript extension (`context/router/`) that provides:

1. **Virtual model router** — registers a `router/auto` model that selects the right EnMaaS tier per turn
2. **`web_search` tool** — DuckDuckGo via fetch
3. **`code_review` tool** — Alibaba open-code-review in delegate mode
4. **MCP tool injection** — discovers and registers tools from any HTTP MCP server at startup

The provider (`enmaas`) is registered by the router extension at boot. The gateway speaks the OpenAI completions API that pi supports natively, so no provider package or patch is needed.

```
  user prompt
      │
      ▼
  pi session
      │  calls router/auto
      ▼
  discoverTiers() → probes the EnMaaS gateway at boot → live tier list
      │
      ▼
  router.ts → selects tier based on complexity + phase
      │
      ├─ trivial / implement phase → DeepSeek V4.1 Flash (free)
      ├─ plan phase (default)      → GLM 5.3 (free)
      └─ retry / escalation        → step up one tier (deepseek → glm → mini → terra)
            │
            ▼
  enmaas provider (openai-completions)  →  $ENMAAS_BASE_URL
```

## Boot-time model discovery

At startup, `discoverTiers()` calls `GET /v1/models` on the EnMaaS gateway with the API key. Every tier candidate the gateway lists is considered available. The list keeps the candidate order, cheapest → most-capable, so the router can step through tiers on retry.

If the API key is missing or the probe fails, the router falls back to `FALLBACK_TIERS` (DeepSeek Flash → GLM 5.3 → GPT 5.4 Mini → GPT 6.1 Terra).

Boot log example:
```
[nous] router: discovered tiers — [0]rits/deepseek-ai/DeepSeek-V4.1-Flash-1017, [1]rits/zai-org/glm-5-3, [2]gpt-5.4-mini, [3]gpt-6.1-terra
```

To add a new candidate model, add it to `TIER_CANDIDATES` in `context/router/enmaas.ts` (cheapest first). It will be probed automatically on next boot.

## Router logic

The router implements a two-phase strategy:

| Phase | Trigger | Model |
|---|---|---|
| Plan | All new turns and continuations | GLM 5.3 (default) or DeepSeek V4.1 Flash (trivial only) |
| Implement | After any write/edit/bash tool call | DeepSeek V4.1 Flash |
| Escalate | On retry | DeepSeek → GLM → Mini → Terra |

**Default is GLM 5.3** (hosted, free of charge). DeepSeek V4.1 Flash is used only when a query is *trivially simple*: fewer than 20 words AND contains no technical keywords (`code`, `function`, `error`, `debug`, `explain`, `analyze`, `review`, `deploy`, `build`, …). Everything else — including short technical questions — goes to GLM 5.3. Both models are free, so normal traffic costs nothing.

**Implement phase** — once any write/edit/bash tool call appears in the message history, the router switches to DeepSeek V4.1 Flash for mechanical implementation turns. If the user then asks something complex mid-session, the plan-phase logic re-evaluates and upgrades back to GLM 5.3.

**Retry escalation** — on each retry the router steps up one tier: DeepSeek → GLM → Mini → Terra. Paid models run only when free models fail.

**Cheap models** — the implement phase prefers the free hosted models (DeepSeek Flash, then GLM 5.3). Paid Gemini Flash models serve only as backup.

**Thinking levels** — explicit `low`/`medium`/`high` settings map to DeepSeek/GLM/Terra regardless of complexity detection. `off` (the default) lets the router decide.

## Models

| Model | Provider | Tier | Charge | Use |
|---|---|---|---|---|
| `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` | enmaas | 0 | **free** (hosted) | Trivial queries, implement phase |
| `rits/zai-org/glm-5-3` | enmaas | 1 | **free** (hosted) | **Default plan phase** |
| `gpt-5.4-mini` | enmaas | 2 | paid | Retry escalation |
| `gpt-6.1-terra` | enmaas | 3 | paid | Retry escalation, manual high-quality selection |

GLM 5.3 and DeepSeek V4.1 Flash are hosted open-weight models and are free of charge. They take the bottom tiers and the plan-phase default, which keeps monthly spend near zero under the strict budget limit. Paid frontier models run only on retry escalation or manual `--model` selection. The gateway also keeps GLM 5.3 available after the monthly budget is exhausted.

Hosted model limits (from the gateway documentation):

- `rits/zai-org/glm-5-3`: 1,000,000-token context window (must not be larger in the client), 65,536-token maximum output, text-only. Frequency and presence penalties must stay 0 — non-zero values make GLM drift into Chinese.
- `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`: do not copy GLM context-window, penalty, or capability settings to DeepSeek.

The full catalog is declared in `context/router/enmaas.ts`. Hosted models are pinned in `HOSTED_MODEL_IDS` because the `/v1/models` response is credential-dependent and can omit them. When the gateway adds models, add them to `CATALOG` there and update this table.

**API dialects.** OpenAI-family models use the Responses API (`/v1/responses`, model-level `api: "openai-responses"`). The gateway rejects function tools combined with `reasoning_effort` on `/v1/chat/completions` for these models — and rejects a missing `reasoning_effort` too, because the model default is non-none. Since a coding agent always sends tools, Responses is the only dialect that supports tools and reasoning together for them. Hosted models (GLM 5.3, DeepSeek) use chat completions. Gemini models are catalog-only: the gateway rejects the standard tool format for them on chat completions, so the router never selects them.

## Personal knowledge wiki (OKF 2.0)

When `/sandbox/wiki` exists (or `WIKI_PATH` env var points elsewhere), three tools are registered at startup:

| Tool | Description |
|---|---|
| `wiki_search` | Recursive scan of all `.md` files outside `raw/`. Scores by title (×10), description (×5), tags (×3), body (×1). Returns top-N results with path, type, description, and a body excerpt. |
| `wiki_read` | Reads a full page by relative path. `.md` extension optional. Path-traversal guarded. |
| `wiki_ingest` | Writes new content to `raw/assets/` with filename sanitisation. The processor agent picks it up on its next ingest run. |

**Wiki format**: [OKF 2.0](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — markdown files with YAML frontmatter (`type`, `title`, `description`, `tags`, `resource`, `sources`). The wiki follows the [LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):

```
/sandbox/wiki/
  index.md           # Catalog — wiki_search reads this first
  log.md             # Chronological ingest history
  <concept>.md       # OKF concept pages
  <subdir>/          # Organized concept groups
  raw/               # Immutable source documents (nous reads, never writes)
    assets/          # Drop new content here via wiki_ingest
```

**Boot log** (wiki present):
```
[nous] wiki: found at /sandbox/wiki — registering wiki_search, wiki_read, wiki_ingest
```

**Boot log** (not mounted):
```
[nous] wiki: not mounted (/sandbox/wiki not found) — wiki tools skipped
```

The wiki tools are no-op when the directory is absent — no configuration needed to opt out.

**Common conventions** — `context/APPEND_SYSTEM.md` is baked into the image at `/sandbox/.pi/agent/APPEND_SYSTEM.md`. It contains:
- ASD-STE100 communication standard (all agent output)
- Work location conventions (`/workspace`, `/sandbox/AGENTS.md`, `/sandbox/wiki/`)
- Git configuration (name, email)
- Wiki-first startup procedure (search before starting any task)

This is additive — it does not override any task-specific `AGENTS.md` mounted at `/sandbox/AGENTS.md`. Pi loads both files without conflict.

## Token compression (rtk-oss)

nous bundles [rtk-oss](https://github.com/rtk-ai/rtk) (Apache-2.0), a Rust binary that compresses shell command output before pi reads it — typically 60–90% token reduction on large command outputs.

At build time, `rtk init --agent pi --global --auto-patch` creates `/sandbox/.pi/agent/extensions/rtk.ts`. Pi auto-discovers it on startup — no runtime configuration needed. The extension hooks into every `bash` tool call and pipes stdout/stderr through rtk's compressor before the token count is measured.

`RTK_VERSION` is tracked by Renovate and pinned to a specific release.

## Built-in tools

### `web_search`

Searches DuckDuckGo lite and returns ranked results with snippets. Always registered.

### `code_review`

Runs [Alibaba open-code-review](https://github.com/alibaba/open-code-review) (`ocr`) in delegate mode. `ocr` analyses the target files with its rule engine and outputs structured review guidance for pi to act on — no second LLM or API key required.

Parameters:
- `files` — array of file paths (optional; omit to let ocr auto-detect changed files in the git workspace)
- `mode` — `"rule"` (default, full review) or `"preview"` (show selected files without reviewing)

Typical flow for a GitHub PR review:
1. pi uses `bash` to clone the repo and fetch the PR branch
2. pi calls `code_review(mode: "preview")` to see which files ocr would select
3. pi calls `code_review(files: [...])` to get rule-based review guidance
4. pi reads the flagged files and produces structured findings

## Productization skills (`nous-productization`)

The productization image bundles [opendatahub-io/productization-skills](https://github.com/opendatahub-io/productization-skills) as native pi skills. Skills are cloned at build time (pinned via the `SKILLS_REF` build-arg, default `main`) and registered via the `skills:` array in `context/settings.json`. pi discovers them automatically on startup — no runtime configuration needed.

### Included skills

| Skill | Domain |
|---|---|
| `jira-sprint-manager` | Jira sprint lifecycle |
| `jira-release-setup` | Jira release management |
| `jira-gap-audit` | Jira gap analysis |
| `jira-utilities` | Jira helpers |
| `jira-cve-tracker` | CVE tracking in Jira |
| `gitlab-branch-manager` | GitLab branch ops |
| `gitlab-code-review` | GitLab MR review |
| `gitlab-job-analyzer` | GitLab CI job analysis |
| `konflux-its-analyzer` | Konflux issue tracking |
| `mapt-provisioner` | MAPT infrastructure |
| `weekly-status` | Weekly status reports |
| `slack-utilities` | Slack messaging |
| `slack-webhook` | Slack webhooks |
| `gws-calendar-reader` | Google Calendar |
| `gws-drive-reader` | Google Drive |
| `gws-slides-analyzer` | Google Slides |
| `gws-doc-action-extractor` | Google Docs action items |
| `aws-log-analyzer` | AWS log analysis |

### Tool CLIs

Installed by the skills-builder stage into `/usr/local/bin/`:

`gh` · `glab` · `jq` · `yq` · `kubectl` · `kustomize` · `tkn` · `uv` · `uvx` · `gws` · `acli` · `kubectl-ka`

Binary collection is resilient — installers run with `|| true` and only successfully-installed binaries are staged, so a failing installer never breaks the build.

### Python runtime

Python 3.12 is installed in the `nous-productization` stage so skills that shell out to Python scripts work out of the box. The base `nous` image (Hummingbird OS) has no package manager, so Python is installed via `uv python install 3.12` into `/opt/uv-python/` with symlinks at `/usr/local/bin/python3` and `/usr/local/bin/pip3`.

### Customising the skills ref

To pin a specific tag or branch of productization-skills:

```bash
podman build \
  --target nous-productization \
  --build-arg SKILLS_REF=v0.9.1 \
  -t nous-productization:0.9.1-0.3.0 .
```

## Egress security

Egress is enforced exclusively at the OpenShell platform layer — kernel-level (Landlock LSM + seccomp), covering every process in the container (`node`, `bash`, `curl`, `git`, etc.).

Policy files live in `security/`:

| File | Purpose |
|---|---|
| `security/nous-policy.yaml` | Production default — EnMaaS + GitHub |
| `security/nous-policy-websearch.yaml` | Adds DuckDuckGo |

Rules are scoped to specific binaries (`/usr/bin/node-26` for pi/ocr, `/usr/bin/git` for clone). Binary paths were resolved inside the image with `readlink -f $(command -v node)`.

## CI / CD

### Build & Publish (`build.yaml`)

```
push to main / v* tag
        │
        ▼
  podman build
        │
        ▼
  container-structure-test
        │
        ▼
  podman push → ghcr.io/aipcc/nous:{sha,latest,version}
```

Runs on `ubuntu-26.04`. Uses `GITHUB_TOKEN` (auto-provided) for GHCR access — no additional secrets.

### Integration Test (`integration.yaml`)

```
  PR / push to main
        │
        ▼
  podman build → nous:test
        │
        ▼
  install OpenShell (curl installer, systemd user service)
        │
        ▼
  start mock-enmaas-server.mjs on :4010
        │  (emits OpenAI SSE stream, no real API key needed)
        ▼
  openshell sandbox create --from nous:test \
    --policy security/nous-policy.yaml --dry-run
  openshell sandbox create --from nous:test \
    --policy security/nous-policy-websearch.yaml --dry-run
        │
        ▼
  [functional job] podman run nous:test
    --env ENMAAS_BASE_URL=http://<runner-ip>:4010/v1
        │
        ▼
  assert output contains expected text
```

Runs on `ubuntu-26.04` (kernel 7.0, Landlock ABI satisfied). No EnMaaS credentials required.

**`ENMAAS_BASE_URL` env var** — when set, the router extension registers the EnMaaS provider against this base URL instead of the production gateway. Only use this in tests.

## Running

### Local podman

```bash
# Interactive
podman run --rm -it \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest

# Pipe a task
echo 'your task here' | \
  podman run --rm -i \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest
```

> Add `--storage-driver=vfs` when running inside a privileged container (CI, dev sandbox).

### OpenShell

```bash
# Interactive
openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider enmaas-nous \
  --policy ./security/nous-policy.yaml

# Pipe a task
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider enmaas-nous \
  --policy ./security/nous-policy.yaml \
  -- pi --print -

# Update policy on a running sandbox
openshell policy update my-sandbox --policy ./security/nous-policy.yaml

# Dry-run before applying
openshell policy update my-sandbox --policy ./security/nous-policy.yaml --dry-run

# Debug shell
openshell sandbox exec -n my-sandbox --tty -- /bin/bash
```

### Integration test (local, no credentials)

```bash
make integration
```
