# CI and tests

[`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml) runs on pull requests to `main`, pushes to `main`, and version tags. The build job creates both image targets. It runs container structure tests and uploads image artifacts for the other jobs.

| Check | Purpose |
|---|---|
| Build | Build both images and check the base image structure. |
| Policy Validation | Validate the default and web-search OpenShell policies. |
| Functional — Smoke Test | Run pi in the base image against a mock EnMaaS server. |
| Subagents — Model and Safety Tests | Test subagent roles and limits in the base image. |
| MCP — Tool Discovery | Test MCP discovery with mock servers. |
| Skills — Productization Image | Check productization skills and selected tools. |
| OpenShell Egress Enforcement | Test allowed and blocked network access. |
| Wiki — OKF 2.0 Integration | Test wiki search and ingestion. |

CI publishes both images on pushes to `main` and version tags. It also publishes PR-specific tags for pull requests from this repository. Fork pull requests do not push images. See [images](images.md#tags).

## Mock EnMaaS server

[`tests/mock-enmaas-server.mjs`](../tests/mock-enmaas-server.mjs) provides model discovery and streaming mock responses. The subagent tests also use a local mock Slack API. These tests do not require real service credentials. They do not establish the quality of model-generated summaries.

## Run tests locally

Run the subagent tests with a compatible Node.js and pi installation:

```bash
node --test --test-timeout=30000 tests/subagent.test.mjs
```

Run `make integration` to build the image and exercise the mock gateway with Podman. `make test` runs the container structure tests against a built image. See [`Makefile`](../Makefile) for prerequisites and image tag defaults.

`ENMAAS_BASE_URL` is required for normal operation. For tests, point it at the mock server. For production, use the approved EnMaaS gateway URL.
