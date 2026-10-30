# Running nous

## Podman

Set `ENMAAS_BASE_URL` to your gateway base URL. Set `ENMAAS_API_KEY` to your gateway key. The base URL has no default.

```bash
podman run --rm -it \
  --env ENMAAS_BASE_URL \
  --env ENMAAS_API_KEY \
  -v /path/to/workspace:/workspace:z \
  ghcr.io/adrianriobo/nous:latest
```

Replace the image with `ghcr.io/adrianriobo/nous-productization:latest` for the productization skills. The workspace mount keeps files after the container exits. Give the container user access to the mount.

To pipe a task:

```bash
echo 'Review PR https://github.com/OWNER/REPO/pull/42' | \
  podman run --rm -i \
    --env ENMAAS_BASE_URL \
    --env ENMAAS_API_KEY \
    -v /path/to/workspace:/workspace:z \
    ghcr.io/adrianriobo/nous:latest
```

Private repositories and external services can require additional credentials. Supply only the credentials needed for the task. A stored pi EnMaaS credential can replace `ENMAAS_API_KEY`; `ENMAAS_BASE_URL` remains required.

See [wiki](wiki.md) for a wiki mount. See [MCP servers](mcp.md) for an MCP configuration. See [subagents](subagents.md) for Slack credentials.

## Private certificate authority

Mount a CA bundle for Node.js connections to internal services:

```bash
-v /path/to/ca-bundle.crt:/run/secrets/ca-bundle.crt:ro,z
```

The entrypoint sets `NODE_EXTRA_CA_CERTS` when the bundle exists. An explicitly set `NODE_EXTRA_CA_CERTS` takes precedence.

## NVIDIA OpenShell

OpenShell applies network policies to the sandbox. The supplied default policy permits EnMaaS and GitHub. The other policies permit DuckDuckGo or Slack. The policies do not apply to a plain Podman run.

Replace `enmaas-gateway.example.com` in the selected policy with your gateway host. Configure access to any other services that your task needs.

```bash
openshell settings set --global --key providers_v2_enabled --value true --yes
openshell provider create \
  --name enmaas-nous \
  --type openai-compatible \
  --config OPENAI_BASE_URL=<your-gateway-base-url> \
  --config OPENAI_API_KEY=<your-api-key>

openshell sandbox create \
  --from ghcr.io/adrianriobo/nous:latest \
  --provider enmaas-nous \
  --policy ./security/nous-policy.yaml
```

Use [`nous-policy-websearch.yaml`](../security/nous-policy-websearch.yaml) for DuckDuckGo access. Use [`nous-policy-slack.yaml`](../security/nous-policy-slack.yaml) for Slack access. Combine the necessary rules if a task needs both. Review the policy before you use confidential data.

To update a sandbox policy:

```bash
openshell policy update my-sandbox --policy ./security/nous-policy.yaml --dry-run
openshell policy update my-sandbox --policy ./security/nous-policy.yaml
```

## Local tests

`make integration` builds an image and runs it against the local mock EnMaaS server. It requires Podman and Node.js, but not a real EnMaaS key. See [CI](ci.md) for the test suite.
