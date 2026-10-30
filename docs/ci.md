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
  podman push → ghcr.io/aipcc/nous:{sha, latest, version}
```

**No secrets required** beyond the auto-provided `GITHUB_TOKEN` (needs `packages: write` — already set in the workflow).

Image is tagged with:
- `latest` on every push to `main`
- The commit SHA on every push
- The version (e.g. `v0.2.0`) when triggered by a `v*` tag

---

## Integration Test (`integration.yaml`)

Triggers on push to `main` and pull requests. Runs the full agent stack without real EnMaaS credentials.

```
  PR / push to main
        │
        ▼
  podman build → nous:test
        │
        ▼
  install OpenShell
  (curl installer → systemd user service)
        │
        ▼
  start tests/mock-enmaas-server.mjs on :4010
  (returns valid OpenAI SSE stream, no API key)
        │
        ▼
  resolve runner host IP
        │
        ▼
  generate test policy with runner IP
        │
        ▼
  openshell sandbox create \
    --from nous:test \
    --policy /tmp/nous-policy-integration-test.yaml \
    --env ENMAAS_BASE_URL=http://<runner-ip>:4010/v1 \
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

## Mock EnMaaS server

`tests/mock-enmaas-server.mjs` is a minimal Node.js HTTP server (no external dependencies) that serves the OpenAI-compatible endpoints pi uses: `GET /v1/models` for tier discovery and `POST /v1/chat/completions` with an OpenAI SSE stream:

```
data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}], ...}
data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"H"}}], ...}
... (streams character by character)
data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}], ...}
data: {"object":"chat.completion.chunk","choices":[],"usage":{...}}
data: <end-of-stream sentinel>
```

The stream must end with the OpenAI end-of-stream sentinel event. pi parses this
stream with the official `openai` SDK. Without the sentinel, the SDK reports a
malformed server-sent event and pi ends the turn with `stopReason: error`.

Override the response text with `MOCK_RESPONSE=<text>`. Port defaults to `4010`.

---

## `ENMAAS_BASE_URL`

When this env var is set inside the container, the router extension registers the EnMaaS provider against this base URL instead of the production gateway. This is what lets the integration test work without credentials.

**Never set this in production.**

---

## Local integration test

```bash
make integration
```

Requires OpenShell installed locally. Starts the mock server, runs the container, tears everything down.
