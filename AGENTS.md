# Instructions for work on nous

## Project

nous packages [pi](https://github.com/earendil-works/pi) with an EnMaaS router and engineering tools. The repository builds two images: `nous` and `nous-productization`.

- Read the [README](README.md) for an overview.
- Read [architecture](docs/architecture.md) for routing and built-in tools.
- Read [images](docs/images.md) for image contents and build targets.
- Read [running](docs/running.md) for credentials and network policies.
- Read [subagents](docs/subagents.md) for child roles and limits.
- Read [journal](docs/journal.md) for the session records and the resume procedure.
- Read [CI](docs/ci.md) for the checks and local tests.

The Containerfile, source, and workflow define current behavior. Check them when you change the documentation.

## Repository work

1. Read the relevant files before you make changes.
2. Keep documentation consistent with the implementation.
3. Run the relevant tests for the change.
4. Run the self review after you change a file. Use repository-relative paths for `code_review`. See [self review](docs/running.md#self-review).
5. Report tests that you could not run.

Use [`context/APPEND_SYSTEM.md`](context/APPEND_SYSTEM.md) for the common instructions included in the image. It is separate from this repository guidance.

## Tool discovery

Use `command -v <tool>` to check a tool. `command -v` is a shell builtin, so it is always available. The image also provides `which`, `curl`, `ps`, `openssl`, `dig`, `host`, and `nslookup`. Use `command -v` before `which`.

## Important limits

- The main router escalates to paid models without a dialog. Set `NOUS_PAID_ESCALATION=off` to block it. See [model routing](docs/architecture.md#model-routing).
- Subagent tool lists are not security sandboxes. Child processes share the parent environment.
- The OpenShell network policies apply only when you run the agent in OpenShell. Start a sandbox with `scripts/nous-openshell.sh`. See [OpenShell](docs/openshell.md).
- A productization tool installer failure fails the image build, unless `TOOL_FAILURE_ALLOWLIST` names the tool. Check the build log for `[nous-build] installer failures`.
- Wiki ingestion saves source documents. A separate processor updates curated pages.
- The journal extension writes `/workspace/journal.md`. The agent closes a record with the `journal` tool. See [journal](docs/journal.md).
- The self-review reminder is not a hard block. Pi cannot stop the answer. The reminder arrives one time for each run. Set `NOUS_SELF_REVIEW=off` to disable it. See [self review](docs/running.md#self-review).
