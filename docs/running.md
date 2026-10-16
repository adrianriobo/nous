# Running nous

## Local — podman

### Interactive session

```bash
podman run --rm -it \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/nous:latest
```

### Pipe a task

```bash
echo 'your task here' | \
  podman run --rm -i \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/nous:latest
```

### Code review a GitHub PR

```bash
# Public repo
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  podman run --rm -i \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/nous:latest

# Private repo — add a GitHub token
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  podman run --rm -i \
  --env ANTHROPIC_VERTEX_PROJECT_ID=<your-project> \
  --env CLOUD_ML_REGION=us-east5 \
  --env GITHUB_TOKEN=<token> \
  -v ~/.config/gcloud/application_default_credentials.json:/sandbox/.config/gcloud/application_default_credentials.json:z \
  ghcr.io/aipcc/nous:latest
```

> Add `--storage-driver=vfs` when running inside a privileged container (CI, nested sandbox).

---

## NVIDIA OpenShell

OpenShell enforces network policy at the kernel level. The agent can only reach what the policy explicitly allows — Vertex AI and GitHub by default.

### One-time provider setup

```bash
openshell settings set --global --key providers_v2_enabled --value true --yes

openshell provider create \
  --name vertex-nous \
  --type google-vertex-ai \
  --from-gcloud-adc \
  --config VERTEX_AI_PROJECT_ID=<your-project> \
  --config VERTEX_AI_REGION=us-east5
```

### Launch

```bash
# Interactive
openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider vertex-nous \
  --policy ./security/nous-policy.yaml

# With web search policy (DuckDuckGo allowed)
openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider vertex-nous \
  --policy ./security/nous-policy-websearch.yaml

# Pipe a task
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider vertex-nous \
  --policy ./security/nous-policy.yaml \
  -- pi --print -
```

### Manage a running sandbox

```bash
# Reconnect
openshell sandbox connect my-sandbox

# Open a debug shell
openshell sandbox exec -n my-sandbox --tty -- /bin/bash

# Update the network policy live
openshell policy update my-sandbox --policy ./security/nous-policy.yaml

# Preview a policy change before applying
openshell policy update my-sandbox --policy ./security/nous-policy.yaml --dry-run
```

---

## Integration test (no credentials needed)

Runs the full stack against a local mock Vertex server:

```bash
make integration
```

See [docs/ci.md](ci.md) for how the mock server works.
