# Instructions for work on nous

## Project

nous packages [pi](https://github.com/earendil-works/pi) with an EnMaaS router and engineering tools. The repository builds two images: `nous` and `nous-productization`.

- Read the [README](README.md) for an overview.
- Read [architecture](docs/architecture.md) for routing and built-in tools.
- Read [images](docs/images.md) for image contents and build targets.
- Read [running](docs/running.md) for credentials and network policies.
- Read [subagents](docs/subagents.md) for child roles and limits.
- Read [CI](docs/ci.md) for the checks and local tests.

The Containerfile, source, and workflow define current behavior. Check them when you change the documentation.

## Repository work

1. Read the relevant files before you make changes.
2. Keep documentation consistent with the implementation.
3. Run the relevant tests for the change.
4. Report tests that you could not run.

Use [`context/APPEND_SYSTEM.md`](context/APPEND_SYSTEM.md) for the common instructions included in the image. It is separate from this repository guidance.

## Important limits

- The main router escalates to paid models without a dialog. Set `NOUS_PAID_ESCALATION=off` to block it. See [model routing](docs/architecture.md#model-routing).
- Subagent tool lists are not security sandboxes. Child processes share the parent environment.
- The OpenShell network policies apply only when you run the agent in OpenShell.
- Productization tool installers can fail without failing the image build.
- Wiki ingestion saves source documents. A separate processor updates curated pages.
