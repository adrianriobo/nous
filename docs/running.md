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

## Session journal

The journal extension records each request in `/workspace/journal.md`. The extension adds an entry for each tool call and each final answer. The agent adds notes and closes the record with the `journal` tool. The file is append-only. A record closes with the status `done`, `blocked`, or `handed-over`. See [journal](journal.md) for the actions and the record format.

The journal persists only when `/workspace` is a host mount. The extension uses the first writable path from `NOUS_JOURNAL`, `/workspace`, and `/sandbox`. Set `--env NOUS_JOURNAL=/workspace/journal.md` to fix the location. Without the mount, the journal is lost when the container exits.

Give the container user access to the mount. User `1001` creates the journal file.

Resume the work after a container restart:

```bash
podman run --rm -it \
  --env ENMAAS_BASE_URL \
  --env ENMAAS_API_KEY \
  -v /path/to/workspace:/workspace:z \
  ghcr.io/adrianriobo/nous:latest \
  --print 'Continue the work from /workspace/journal.md. Use the newest open record.'
```

List the records that are not closed:

```bash
grep -nE -- '- status: (open|blocked)' /path/to/workspace/journal.md
```

A record ID has the form `J-YYYYMMDD-NN`. Keep the journal file with the workspace artifacts. The journal adds context when you start a new session.

## Window title

Each container sets the pi terminal title. Use `NOUS_TITLE` to give each tab its own name:

```bash
podman run --rm -it \
  --env ENMAAS_BASE_URL \
  --env ENMAAS_API_KEY \
  --env NOUS_TITLE="nous | RHAII migration" \
  -v /path/to/workspace:/workspace:z \
  ghcr.io/adrianriobo/nous:latest
```

Without `NOUS_TITLE`, pi sets `π - <session name> - <cwd>`. The container working directory is constant, so every tab then shows `π - sandbox`.

Change the title during a session:

```text
/title RHAII migration      set the title for this session
/title                      show the current title source
/title reset                return to NOUS_TITLE or the pi default
```

The title needs a TTY. Use `podman run -t`. tmux shows the title only with `set -g set-titles on` and `set -g set-titles-string "#T"`.

The extension removes control characters from the value. Keep the value on one line.

pi writes its own title after the extension writes the custom title. The extension rewrites each title sequence that pi writes. The custom title therefore shows at startup, without `/reload`. The title stays after `/name`, `/reload`, and a session switch.

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
