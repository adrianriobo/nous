# CI / CD

Two GitHub Actions workflows ship with the repo, both running on `ubuntu-26.04`.

---

## Build & Publish (`build.yaml`)

Triggers on push to `main`, any `v*` tag, and pull requests (build only — no push on PRs).

```
push to main / v* tag
        │
        ▼
  podman build
        │
        ▼
  container-structure-test
        │
        ▼
  podman push → ghcr.io/aipcc/haropz:{sha, latest, version}
```

**No secrets required** beyond the auto-provided `GITHUB_TOKEN` (needs `packages: write` — already set in the workflow).

Image is tagged with:
- `latest` on every push to `main`
- The commit SHA on every push
- The version (e.g. `v0.2.0`) when triggered by a `v*` tag

---

## Integration Test (`integration.yaml`)

Triggers on push to `main` and pull requests. Runs the full agent stack without real Vertex AI credentials.

```
  PR / push to main
        │
        ▼
  podman build → haropz:test
        │
        ▼
  install OpenShell
  (curl installer → systemd user service)
        │
        ▼
  start tests/mock-vertex-server.mjs on :4010
  (returns valid Anthropic SSE stream, no API key)
        │
        ▼
  resolve runner host IP
        │
        ▼
  generate test policy with runner IP
        │
        ▼
  openshell sandbox create \
    --from haropz:test \
    --policy /tmp/haropz-policy-integration-test.yaml \
    --env VERTEX_API_BASE_URL=http://<runner-ip>:4010 \
    --no-keep \
    -- pi --print -
        │
        ▼
  assert output contains expected text
        │
        ▼
  yamllint + openshell --dry-run on production policy files
```

**No secrets required.**

---

## Mock Vertex server

`tests/mock-vertex-server.mjs` is a minimal Node.js HTTP server (no external dependencies) that accepts any POST and returns a valid Anthropic SSE stream:

```
data: {"type":"message_start", ...}
data: {"type":"content_block_start", ...}
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"H"}}
... (streams character by character)
data: {"type":"content_block_stop", ...}
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}, ...}
data: {"type":"message_stop"}
```

Override the response text with `MOCK_RESPONSE=<text>`. Port defaults to `4010`.

---

## `VERTEX_API_BASE_URL`

When this env var is set inside the container, `vertex-api-patch.ts` replaces the Vertex AI base URL with the provided value and skips Google auth token fetch entirely. This is what lets the integration test work without credentials.

**Never set this in production.**

---

## Local integration test

```bash
make integration
```

Requires OpenShell installed locally. Starts the mock server, runs the container, tears everything down.
