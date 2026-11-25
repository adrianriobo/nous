# OpenShell

[OpenShell](https://github.com/ai-openshell/openshell) runs nous in a sandbox with an enforced network policy. The agent can reach only the hosts in the policy.

A plain Podman run does not apply a network policy. Use OpenShell when a task reads or changes confidential data.

## Differences from a Podman run

| Topic | Podman | OpenShell |
|---|---|---|
| Workspace | Bind mount at `/workspace` | Sandbox volume at `/sandbox` |
| Journal | `/workspace/journal.md` | `/sandbox/journal.md` |
| Start command | Image entrypoint | Command `-- /usr/local/bin/entrypoint.sh` |
| Egress | No limit | Default deny, policy required |
| Credentials | Environment variables | Provider placeholders |

OpenShell replaces the image entrypoint with its own supervisor. Thus the sandbox must start the nous entrypoint as the command. The entrypoint checks the credentials and starts pi.

The helper script sets this command for you.

## Requirements

- Linux or macOS on Apple Silicon.
- Docker 28 or later, or Podman 5.x with an active user socket.
- An EnMaaS gateway URL and key.

## Install OpenShell

The repository tests OpenShell `v0.1.10`. Read the version from the CI file:

```bash
grep OPENSHELL_VERSION .github/workflows/ci.yaml
```

Run the installer. It installs the CLI, the policy prover, and a local gateway:

```bash
curl -LsSf https://raw.githubusercontent.com/ai-openshell/openshell/main/install.sh | sh
```

On Linux, the installer needs root privileges for the package. To install the same version as the CI file:

```bash
curl -LsSf https://raw.githubusercontent.com/ai-openshell/openshell/main/install.sh | \
  OPENSHELL_VERSION=v0.1.10 sh
```

Check the gateway:

```bash
openshell status
```

See the [OpenShell installation guide](https://github.com/ai-openshell/openshell/blob/main/docs/about/installation.mdx) for the Kubernetes install and the Windows build.

## Start a session

Clone the repository. The script and the policies are in it.

```bash
git clone https://github.com/adrianriobo/nous.git
cd nous
```

Set the credentials in your shell. Do not put the key on a command line.

```bash
export ENMAAS_BASE_URL=https://your-gateway.example.com/v1
export ENMAAS_API_KEY=your-key
```

Start pi:

```bash
./scripts/nous-openshell.sh
```

Use the productization image:

```bash
./scripts/nous-openshell.sh --productization
```

Pin a version:

```bash
./scripts/nous-openshell.sh --tag v0.3.0
./scripts/nous-openshell.sh --productization --tag 0.9.1-0.3.0
```

The productization tag combines the skills version and the nous version. See [images](images.md#tags).

Use a short task instead of an interactive session:

```bash
./scripts/nous-openshell.sh --task "Review PR 42 in this repository"
```

The script gives these options:

| Option | Effect |
|---|---|
| `--productization` | Use `ghcr.io/adrianriobo/nous-productization`. |
| `--image REPO` | Select the image repository without a tag. Use it for a local registry. This option replaces `--productization`. Default: `ghcr.io/adrianriobo/nous`. |
| `--tag TAG` | Select the image tag. Default: `latest`. |
| `--name NAME` | Select the sandbox name. Default: the image variant. |
| `--workspace DIR` | Upload `DIR`. Default: the current folder. |
| `--no-upload` | Keep the current sandbox workspace. |
| `--task TEXT` | Send one task to pi and exit. |
| `--recreate` | Delete the sandbox first. This deletes its workspace. |
| `--policy FILE` | Use your policy file. |
| `--dry-run` | Print the commands. Change no OpenShell state. |

The script uses the OpenShell workspace from `OPENSHELL_WORKSPACE`. The default is `default`.

Run the script from the folder that you want to work on. The script uploads the current folder. Use `/path/to/nous/scripts/nous-openshell.sh --workspace /path/to/project` to work on another folder.

## What the script does

1. Read the gateway host and port from `ENMAAS_BASE_URL`.
2. Write the provider profile to `~/.local/state/nous-openshell/enmaas-profile.yaml`.
3. Write the policy to `~/.local/state/nous-openshell/nous-policy.yaml`.
4. Import the profile. Create or update the provider `enmaas-nous`.
5. Create the sandbox with `-- /usr/local/bin/entrypoint.sh` and a terminal.
6. Upload the workspace to `/sandbox`.
7. Attach the terminal.

The provider gives pi a placeholder for the key. OpenShell replaces the placeholder only for requests to the gateway host.

The profile limits the key to the Node.js binary `/usr/bin/node-26`. Change this path when the base image changes it.

## Environment variables

The script forwards `ENMAAS_BASE_URL` only. It does not forward your other shell variables. Use `--env-file` or `--env` for the variables that the session needs:

```bash
./scripts/nous-openshell.sh --env-file .env
./scripts/nous-openshell.sh --env NOUS_TITLE="nous | migration" --env NOUS_PAID_ESCALATION=off
```

This is the same set of variables that you pass to `podman run --env-file`. Repeat `--env-file` and `--env` to add more. An `--env` value wins over an env file value.

The script reads each value and forwards the name with `--env-from`. The value does not appear in the process arguments.

| Variable | Purpose |
|---|---|
| `NOUS_TITLE` | Set the terminal title. |
| `NOUS_PAID_ESCALATION=off` | Stop automatic escalation to paid models. |
| `NOUS_JOURNAL` | Set the journal path. Default: the first writable path from `/sandbox/journal.md`. |
| `WIKI_PATH` | Set the wiki path. Default: `/sandbox/wiki`. |
| `NODE_EXTRA_CA_CERTS` | Set a CA bundle for TLS. |
| `SLACK_XOXC_TOKEN`, `SLACK_XOXD_TOKEN`, `SLACK_WORKSPACE` | Let the Slack reader use the Slack API. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Let `gh` and `git` use the GitHub API. |
| `PI_NOUS_SUBAGENT_ROLE` | Set by the subagent runner. Do not set it. |

`ENMAAS_BASE_URL` and `ENMAAS_API_KEY` come from the shell and the provider. The script skips them in an env file. The provider sends a placeholder for the key.

The env file accepts one `KEY=VALUE` pair per line. A leading `export` is optional. The script removes one pair of quotes around a value. It does not expand `$VAR` or run commands.

The file can also set `ENMAAS_BASE_URL` and `ENMAAS_API_KEY`. You can then run the script with `--env-file .env` only.

The wiki is not a mount. Upload it into the sandbox:

```bash
openshell sandbox upload nous /path/to/wiki /sandbox/wiki
```

### Secrets

A provider is better than an env file for a secret. The sandbox holds a placeholder, and OpenShell replaces it only for the provider endpoints. The OpenShell catalog includes profiles for `github`, `aws`, `pypi`, and other services. Import a profile and attach it:

```bash
openshell profile import -f github.yaml
./scripts/nous-openshell.sh --provider github
```

The script attaches `enmaas-nous` and each provider from `--provider`.

A variable alone does not grant network access. The sandbox policy must also allow the host and the binary. A provider profile carries its own endpoints. For other hosts, add the endpoint to the policy. See [Extra network access](#extra-network-access).

## Manual setup

The script runs these commands. Run them yourself when you must control each step.

```bash
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/nous-openshell"

openshell profile lint -f "$STATE/enmaas-profile.yaml"
openshell profile import -f "$STATE/enmaas-profile.yaml"

# Profile from an earlier run: lint fails, so update it instead.
# An update needs the current resource version.
VERSION=$(openshell profile export enmaas -o yaml | sed -n 's/^resource_version: //p')
printf 'resource_version: %s\n' "$VERSION" >> "$STATE/enmaas-profile.yaml"
openshell profile update enmaas -f "$STATE/enmaas-profile.yaml"

openshell provider create \
  --name enmaas-nous \
  --type enmaas \
  --from-existing

openshell sandbox create \
  --name nous \
  --from ghcr.io/adrianriobo/nous:latest \
  --provider enmaas-nous \
  --policy "$STATE/nous-policy.yaml" \
  --env-from ENMAAS_BASE_URL \
  -- /usr/local/bin/entrypoint.sh
```

The provider profile and the policy come from the helper script. Run `./scripts/nous-openshell.sh --dry-run` to write them.

## Workspace and journal

The sandbox keeps its workspace in a persistent volume at `/sandbox`. The volume stays until you delete the sandbox. The journal is `/sandbox/journal.md`.

Upload the contents of a local folder. Run the command from that folder:

```bash
cd /path/to/project
openshell sandbox upload nous . /sandbox
```

A `.` source copies the folder contents. A folder path copies the folder into `/sandbox` as a subfolder.

Download a result:

```bash
openshell sandbox download nous /sandbox/report.md ./report.md
```

The upload and the download operate only on paths inside `/sandbox`.

Use `--no-upload` to keep the existing sandbox workspace. Use `--workspace DIR` to replace it with another folder.

## Resume and cleanup

Attach to a sandbox again:

```bash
openshell sandbox start nous
openshell sandbox connect nous
```

`start` also starts a completed sandbox again. The workspace is unchanged.

Stop the compute and keep the workspace:

```bash
openshell sandbox stop nous
```

Delete the sandbox and its workspace:

```bash
openshell sandbox delete nous
```

List the sandboxes:

```bash
openshell sandbox list
```

## Extra network access

The default policy permits the EnMaaS gateway and GitHub. Use another policy when a task needs more access.

The web search policy permits DuckDuckGo:

```bash
cp security/nous-policy-websearch.yaml /tmp/nous-policy-websearch.yaml
```

Edit the copy. Set `enmaas-gateway.example.com` to your gateway host. Set `port` when the gateway does not use 443. Then start the sandbox with the copy:

```bash
./scripts/nous-openshell.sh --policy /tmp/nous-policy-websearch.yaml
```

The Slack policy is `security/nous-policy-slack.yaml`. Combine the rules when a task needs both services.

Validate and apply a policy to a running sandbox:

```bash
openshell policy lint /tmp/nous-policy-websearch.yaml
openshell policy set nous --policy /tmp/nous-policy-websearch.yaml --wait
```

For another service, import a [provider profile](https://github.com/ai-openshell/openshell/tree/main/providers). Attach the provider with `--provider` on `openshell sandbox create`. The helper script does not attach extra providers.

## MCP servers

A sandbox has no bind mount for `/run/secrets/mcp.json`. Upload the file to the pi configuration folder instead:

```bash
openshell sandbox upload nous ./mcp.json /sandbox/.pi/agent/mcp.json --no-git-ignore
```

Add a network rule for each MCP server host. Then start a new pi process, or run `openshell sandbox exec nous -- pi`.

## Limits

- **Binary allowlist.** The policy permits network access for `node` and `git`. Tools such as `gh`, `glab`, and `kubectl` in the productization image cannot reach the network until you add them to a policy. Add a provider profile for their credentials.
- **No bind mounts.** OpenShell copies files into the sandbox. It does not share a host folder. Use `openshell sandbox upload` and `openshell sandbox download`.
- **Duplicate upload.** The upload starts after pi starts. A large upload can take time. Wait for the upload message before you send the first task.
- **Stale policy.** A new gateway host needs a new policy. Rerun the script with `--recreate`, or run `openshell policy set`.
- **Image access.** The gateway pulls the image. A private image needs registry credentials on the gateway host.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `ENMAAS_BASE_URL is not set` | The sandbox has no base URL. | Start the sandbox with `--env-from ENMAAS_BASE_URL`. |
| `no auth configured` | The provider is not attached. | Attach the provider. Start a new sandbox. |
| `credential_endpoint_mismatch` | The profile does not permit the request host. | Set the gateway host in the profile. Import the profile again. |
| `no existing local credentials` | The provider has no key. | Set `ENMAAS_API_KEY` in the shell. Create the provider with `--from-existing`. |
| Egress denied for a host | The policy does not permit the host. | Add the rule. Run `openshell policy set`. |
| pi does not start | The sandbox started the login shell. | Use the command `-- /usr/local/bin/entrypoint.sh`. |
| The gateway cannot find the image | The gateway host has no access to the registry. | Push the image to a registry that the gateway can read. |

Inspect the sandbox:

```bash
openshell sandbox get nous
openshell policy get nous --full
openshell sandbox provider list nous
openshell logs nous --tail
```
