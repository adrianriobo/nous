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

1. **Virtual model router** — registers a `router/auto` model that selects the right Claude tier per turn
2. **`web_search` tool** — DuckDuckGo via fetch
3. **`code_review` tool** — Alibaba open-code-review in delegate mode
4. **MCP tool injection** — discovers and registers tools from any HTTP MCP server at startup

The provider (`pi-provider-vertex-anthropic`) is installed at image build time. `context/vertex-api-patch.ts` overlays the provider's `src/vertex-api.ts` to fix a bug where tools were never sent to the Vertex API (the provider read `context.tools` which pi never populates; the fix extracts tools from pi's system messages instead).

```
  user prompt
      │
      ▼
  pi session
      │  calls router/auto
      ▼
  router.ts → selects tier based on complexity + phase
      │
      ├─ simple / implement phase → claude-haiku-4-5  (or Gemini Flash if available)
      ├─ complex / plan phase     → claude-sonnet-4-5
      └─ retry / escalation       → claude-opus-4-6
            │
            ▼
  pi-provider-vertex-anthropic  →  Vertex AI (googleapis.com)
```

## Router logic

The router implements a two-phase strategy:

| Phase | Trigger | Model |
|---|---|---|
| Plan | All new turns and continuations | Opus 4.6 (default) or Haiku (trivial only) |
| Implement | After any write/edit/bash tool call | Haiku or Gemini Flash |
| Escalate | On retry | Haiku → Sonnet → Opus 4.6 |

**Default is Opus 4.6** ($5/1M input — best available on Vertex AI). Haiku is used only when a query is *trivially simple*: fewer than 20 words AND contains no technical keywords (`code`, `function`, `error`, `debug`, `explain`, `analyze`, `review`, `deploy`, `build`, …). Everything else — including short technical questions — goes to Sonnet.

**Implement phase** — once any write/edit/bash tool call appears in the message history, the router switches to Haiku (or Gemini Flash if available) for mechanical implementation turns. If the user then asks something complex mid-session, the plan-phase logic re-evaluates and can upgrade back to Sonnet.

**Retry escalation** — on each retry the router steps up one tier: Haiku → Sonnet → Opus.

**Gemini Flash** — when a Gemini Flash model is registered (2.0 or 1.5 variants), it is preferred over Haiku for cheap turns.

**Thinking levels** — explicit `low`/`medium`/`high` settings map to Haiku/Sonnet/Opus regardless of complexity detection. `off` (the default) lets the router decide.

## Models

| Model | Provider | Tier | Cost (input/1M) | Use |
|---|---|---|---|---|
| `claude-haiku-4-5@20251001` | vertex-anthropic | 0 | $1 | Trivial queries, implement phase |
| `claude-sonnet-4-5@20250929` | vertex-anthropic | 1 | $3 | Retry escalation intermediate |
| `claude-opus-4-6` | vertex-anthropic | 2 | $5 | **Default plan phase** |
| `gemini-2.0-flash-001` | google-vertex | — | — | Cheapest fallback for implement phase (if available) |

Opus 4.6 is both the highest quality and most cost-effective premium model available on Vertex AI via `pi-provider-vertex-anthropic`. When Claude 5 models appear on Vertex, bump `PI_PROVIDER_VERTEX_VERSION` in the Containerfile and update this table.

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
| `security/nous-policy.yaml` | Production default — Vertex AI + GitHub |
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
  start mock-vertex-server.mjs on :4010
        │  (emits Anthropic SSE stream, no real API key needed)
        ▼
  openshell sandbox create --from nous:test \
    --policy security/nous-policy.yaml --dry-run
  openshell sandbox create --from nous:test \
    --policy security/nous-policy-websearch.yaml --dry-run
        │
        ▼
  [functional job] podman run nous:test
    --env VERTEX_API_BASE_URL=http://<runner-ip>:4010
        │
        ▼
  assert output contains expected text
```

Runs on `ubuntu-26.04` (kernel 7.0, Landlock ABI satisfied). No Vertex AI credentials required.

**`VERTEX_API_BASE_URL` env var** — when set, `vertex-api-patch.ts` replaces the Vertex AI base URL and skips Google auth token fetch. Only use this in tests.

## Running

### Local podman

```bash
# Interactive
podman run --rm -it \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/nous:latest

# Pipe a task
echo 'your task here' | \
  podman run --rm -i \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/nous:latest
```

> Add `--storage-driver=vfs` when running inside a privileged container (CI, dev sandbox).

### OpenShell

```bash
# Interactive
openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider vertex-nous \
  --policy ./security/nous-policy.yaml

# Pipe a task
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider vertex-nous \
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
