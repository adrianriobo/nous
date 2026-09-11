# haropz

OCI image that layers an **omnigent routing proxy** on top of the Red Hat AI
`agentic/pi` harness.  Incoming tasks are classified by complexity and delegated
to the cheapest Claude model tier that can handle them, reducing token spend
without sacrificing quality.

```
┌──────────────┐     task      ┌──────────────────────────────┐
│   client /   │ ──────────►  │  omnigent router             │
│   pipeline   │              │  (complexity classifier)       │
└──────────────┘              └──────────┬────────┬───────────┘
                                         │        │
                              ┌──────────▼──┐  ┌──▼──────────┐  ┌──────────────┐
                              │  pi-haiku   │  │ pi-sonnet   │  │  pi-opus     │
                              │ (Haiku 4.5) │  │(Sonnet 4.6) │  │ (Opus 4.7)   │
                              └─────────────┘  └─────────────┘  └──────────────┘
```

## Running

The image supports two authentication backends.  Create a `.env` file from one
of the templates below, then use `--env-file` to pass it to `podman run`.

### Option A — Anthropic API (direct)

**`.env` file:**

```env
# Anthropic direct auth
ANTHROPIC_API_KEY=sk-ant-api03-...

# Optional tuning
LOG_LEVEL=info
OTEL_ENABLED=false
```

**Run — server mode (default, persistent, web UI on :6767):**

```bash
podman run --rm -d \
  --env-file .env \
  -p 6767:6767 \
  --name haropz \
  quay.io/aipcc/haropz:latest

# Open in browser:
#   http://127.0.0.1:6767
```

| Port | Service |
|---|---|
| `6767` | Runner API / WebSocket + Web UI |

---

### Option B — Vertex AI (GCP)

You need your GCP service account JSON key file on the host.  The container
expects it mounted at a path you control; `/sandbox/gcp-creds.json` is used
below as a convention.

**Host files required:**

| Host path | Description |
|---|---|
| `~/gcp-creds.json` | GCP service account JSON downloaded from the Cloud Console (`IAM & Admin → Service Accounts → Keys → Add Key → JSON`) |

**`.env` file:**

```env
# Vertex AI auth — do NOT set ANTHROPIC_API_KEY when using this mode
GOOGLE_APPLICATION_CREDENTIALS=/sandbox/gcp-creds.json
GOOGLE_CLOUD_PROJECT=my-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-east5

# Optional tuning
LOG_LEVEL=info
OTEL_ENABLED=false
```

> Supported regions for Claude on Vertex: `us-east5`, `europe-west1`, `asia-southeast1`

**Run — interactive (pi session):**

```bash
podman run --rm -it \
  --env-file .env \
  -v ~/gcp-creds.json:/sandbox/gcp-creds.json:ro,Z \
  quay.io/aipcc/haropz:latest
```

**Run — server mode (accessible from host):**

```bash
podman run --rm -d \
  --env-file .env \
  -v ~/gcp-creds.json:/sandbox/gcp-creds.json:ro,Z \
  -p 6767:6767 \
  -p 8000:8000 \
  quay.io/aipcc/haropz:latest \
  server
```

The `:ro,Z` flags make the credential file read-only and apply the correct
SELinux label for OpenShift / RHEL hosts.

---

### Bypassing the router

To call `pi` directly with a specific model (no routing overhead):

```bash
# Anthropic direct
podman run --rm -it \
  --env-file .env \
  quay.io/aipcc/haropz:latest \
  pi

# Vertex AI
podman run --rm -it \
  --env-file .env \
  -v ~/gcp-creds.json:/sandbox/gcp-creds.json:ro,Z \
  quay.io/aipcc/haropz:latest \
  pi
```

---

## Environment variables

### Anthropic direct

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (`sk-ant-...`) |

### Vertex AI

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | Path to the GCP service account JSON or ADC file **inside the container** |
| `GOOGLE_CLOUD_PROJECT` | Yes | GCP project ID where Claude is enabled |
| `GOOGLE_CLOUD_LOCATION` | Yes | GCP region (`us-east5`, `europe-west1`, `asia-southeast1`) |

### Common

| Variable | Default | Description |
|---|---|---|
| `OMNIGENT_CONFIG_HOME` | `/sandbox/.omnigent` | Directory containing omnigent's `config.yaml` (pre-baked in image) |
| `LOG_LEVEL` | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
| `OTEL_ENABLED` | `false` | Emit OpenTelemetry token-usage metrics |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP collector endpoint |

---

## Routing behaviour

Omnigent evaluates each task against complexity triggers defined in
`config/omnigent.yaml`.  When a task matches multiple tiers it starts with the
cheapest and escalates only if the model self-assesses as incapable.

See [AGENTS.md](AGENTS.md) for the full agent topology and routing rules.

---

## Building

```bash
# Standard build
make build

# Override base image or version
make build BASE_IMAGE=quay.io/aipcc/base-images/agentic/pi:0.85.1-1788880178 VERSION=0.2.0

# Build and push
make all
```

## Testing

```bash
# Container structure tests (requires container-structure-test binary)
make test

# Runtime smoke tests
make smoke                        # entrypoint checks only
ANTHROPIC_API_KEY=sk-... make smoke   # includes live Anthropic routing tests
```

## Project layout

```
haropz/
├── Containerfile           # OCI image definition
├── config/
│   └── omnigent.yaml       # Routing rules and model tiers
├── context/
│   └── entrypoint.sh       # Entrypoint wrapper
└── tests/
    ├── structure-test.yaml  # container-structure-test assertions
    └── smoke_test.sh        # Runtime smoke tests
```
