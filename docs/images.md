# Images

The [`Containerfile`](../Containerfile) defines three image targets. CI publishes the two pi targets under the repository owner's GitHub Container Registry namespace.

| Target | Image | Contents |
|---|---|---|
| `nous` | `ghcr.io/adrianriobo/nous` | pi, EnMaaS router, subagents, wiki tools, web search, open-code-review, and rtk-oss. |
| `nous-productization` | `ghcr.io/adrianriobo/nous-productization` | Base image plus productization skills, Python 3.12, and successfully installed CLI tools. |
| `nous-oce` | `quay.io/aipcc/base-images/agentic/nous-oce` | pi-free target. The OpenClaw Enterprise runtime plus the nous entrypoint. |

The base image builds from `quay.io/aipcc/base-images/agentic/pi`. It installs [Alibaba open-code-review](https://github.com/alibaba/open-code-review) and [rtk-oss](https://github.com/rtk-ai/rtk). The Containerfile pins their versions.

The productization image includes [productization-skills](https://github.com/opendatahub-io/productization-skills). These cover Jira, GitLab, Konflux, Slack, Google Workspace, AWS logs, and infrastructure provisioning. `SKILLS_REF` selects the skills release at build time.

The skills builder attempts to install its CLI tools. Examples include `gh`, `glab`, `kubectl`, `kustomize`, `tkn`, `acli`, and `gws`. An installer failure does not fail the image build. Check the build log or the image when a specific tool is required. External services can require credentials and network access.

## Tags

On a push to `main` that starts CI, the workflow publishes `latest` and the commit SHA for the base image. Documentation-only branch pushes do not start CI. A version-tag build publishes the version, commit SHA, and `latest` tags. The productization image uses a tag that combines the skills version and the nous version or commit SHA. For example, `0.9.1-0.3.0` identifies skills `v0.9.1` and nous `v0.3.0`.

For a pull request from this repository, CI also pushes PR-specific tags. Fork pull requests build images but do not push them. See [CI](ci.md) for the current workflow.

## Build locally

Clone the repository. Build the desired target:

```bash
git clone https://github.com/adrianriobo/nous.git
cd nous
podman build --target nous -t nous:local .
podman build --target nous-productization -t nous:productization-local .
```

Set `--build-arg SKILLS_REF=<tag>` to select another skills release. `make build` is also available; it uses the Containerfile's default target. See [`Makefile`](../Makefile) for its image and tag defaults.

## OCE image family

The `nous-oce` target builds on `quay.io/aipcc/base-images/agentic/oce-runtime`. The OpenClaw Enterprise (OCE) runtime supplies the gateway, the OpenClaw harness, `gh`, and `tini`. The target adds the nous labels and the gateway entrypoint. It keeps the base layout that OCE requires.

| Item | Value |
|---|---|
| Base image | `quay.io/aipcc/base-images/agentic/oce-runtime`, selected by `OCE_BASE_TAG` |
| User | `node`, UID 1000 and GID 1000 |
| Workdir | `/app` |
| Required paths | `/app`, `/home/node`, `/usr/bin/tini`, `/usr/local/bin/node`, `/usr/local/bin/gh` |
| Entrypoint | `/usr/bin/tini -s -e 143 --` |
| Default command | `/usr/local/bin/nous-gateway` |

OCE ignores the image entrypoint. It starts the gateway with its own generated Node.js program. The default command serves a local run and the smoke test only.

OCE runs agent Pods as UID/GID 1000 with `runAsNonRoot`. Test every change with that identity:

```bash
make build-oce
make test-oce
make smoke-oce
```

A release build pins the base by digest:

```bash
podman build --target nous-oce \
  --build-arg OCE_BASE_IMAGE=quay.io/aipcc/base-images/agentic/oce-runtime@sha256:<digest> \
  -t nous-oce:local .
```

`make push-oce` publishes to `OCE_REGISTRY`, which defaults to `quay.io/aipcc/base-images/agentic`. Override it when the namespace is not writable.

The RHOAI profile selects this image through `images.gateway`. That setting applies to every OpenClaw Agent on one Installation.

CI does not publish this target yet. See task #75 in the epic for the build and publish workflow.
