# Running nous

## Local — podman

### Interactive session

```bash
podman run --rm -it \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest
```

### Pipe a task

```bash
echo 'your task here' | \
  podman run --rm -i \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest
```

### Code review a GitHub PR

```bash
# Public repo
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  podman run --rm -i \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  ghcr.io/aipcc/nous:latest

# Private repo — add a GitHub token
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  podman run --rm -i \
  --env ENMAAS_API_KEY=<your-api-key> \
  --env ENMAAS_BASE_URL=<your-gateway-base-url> \
  --env GITHUB_TOKEN=<token> \
  ghcr.io/aipcc/nous:latest
```

> Add `--storage-driver=vfs` when running inside a privileged container (CI, nested sandbox).

---

## NVIDIA OpenShell

OpenShell enforces network policy at the kernel level. The agent can only reach what the policy explicitly allows — EnMaaS and GitHub by default.

### One-time provider setup

```bash
openshell settings set --global --key providers_v2_enabled --value true --yes

openshell provider create \
  --name enmaas-nous \
  --type openai-compatible \
  --config OPENAI_BASE_URL=<your-gateway-base-url> \
  --config OPENAI_API_KEY=<your-api-key>
```

### Launch

```bash
# Interactive
openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider enmaas-nous \
  --policy ./security/nous-policy.yaml

# With web search policy (DuckDuckGo allowed)
openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider enmaas-nous \
  --policy ./security/nous-policy-websearch.yaml

# Pipe a task
echo 'Review PR https://github.com/OWNER/REPO/pull/NNN' | \
  openshell sandbox create \
  --from ghcr.io/aipcc/nous:latest \
  --provider enmaas-nous \
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

Runs the full stack against a local mock EnMaaS server:

```bash
make integration
```

See [docs/ci.md](ci.md) for how the mock server works.
