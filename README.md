# haropz

A production-ready [pi](https://github.com/earendil-works/pi) coding agent with Vertex AI, built for secure enterprise environments.

## What you get

**Smart model routing** — automatically picks the right Claude model for each task. Simple questions go to Haiku, complex plans to Sonnet, deep reasoning to Opus. No configuration needed.

**Web search** — DuckDuckGo search built in. The agent searches the web when it needs current information without you having to ask.

**AI code review** — powered by [Alibaba open-code-review](https://github.com/alibaba/open-code-review). Point it at a GitHub PR and it gives you structured, rule-based feedback.

**Kernel-level egress control** — runs inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell), which enforces network policy at the kernel level. The agent can only reach what you explicitly allow.

## Quick start

```bash
# Pull and run interactively
podman run --rm -it \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/haropz:latest

# Or pipe a task
echo 'Review PR https://github.com/OWNER/REPO/pull/42' | \
  podman run --rm -i \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/haropz:latest
```

## Credentials

haropz needs two env vars and Google credentials:

| Variable | Description |
|---|---|
| `ANTHROPIC_VERTEX_PROJECT_ID` | Your GCP project ID |
| `CLOUD_ML_REGION` | Vertex AI region, e.g. `us-east5` |

For credentials, mount your ADC file (shown above) or set `GOOGLE_APPLICATION_CREDENTIALS` to a service account JSON path.

## Build your own

```bash
git clone https://github.com/aipcc/haropz
make build
```

## Go deeper

| Topic | Doc |
|---|---|
| Running with podman, OpenShell, and integration tests | [docs/running.md](docs/running.md) |
| CI/CD workflows and mock Vertex server | [docs/ci.md](docs/ci.md) |
| Router logic, model tiers, tools, egress architecture | [AGENTS.md](AGENTS.md) |
