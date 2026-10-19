#!/bin/bash
# Auth modes:
#   Anthropic direct : ANTHROPIC_API_KEY
#   Vertex AI (SA)   : GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS
#   Vertex AI (ADC)  : GOOGLE_CLOUD_PROJECT + ~/.config/gcloud/application_default_credentials.json
set -euo pipefail

_write_pi_creds() {
    local creds=/sandbox/.pi-creds.env
    : > "$creds"
    for var in ANTHROPIC_VERTEX_PROJECT_ID GOOGLE_CLOUD_PROJECT \
                GOOGLE_CLOUD_LOCATION CLOUD_ML_REGION \
                GOOGLE_APPLICATION_CREDENTIALS ANTHROPIC_API_KEY; do
        local val
        read -r val <<< "${!var:-}"   # strips leading/trailing whitespace
        [[ -n "$val" ]] && printf 'export %s=%q\n' "$var" "$val" >> "$creds"
    done
    chmod 600 "$creds"
}

_check_auth() {
    # Skip auth when using a mock/override endpoint (integration tests)
    [[ -n "${VERTEX_API_BASE_URL:-}" ]] && return 0
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then return 0; fi
    local has_project="${GOOGLE_CLOUD_PROJECT:-}${ANTHROPIC_VERTEX_PROJECT_ID:-}"
    if [[ -n "${has_project}" ]]; then
        [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] && return 0
        [[ -f "${HOME}/.config/gcloud/application_default_credentials.json" ]] && return 0
    fi
    echo >&2 "ERROR: no auth configured. Set ANTHROPIC_API_KEY, or GOOGLE_CLOUD_PROJECT + credentials."
    return 1
}

_inject_ca() {
    local ca=/run/secrets/ca-bundle.crt
    # NODE_EXTRA_CA_CERTS already set explicitly — honour it as-is
    if [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]]; then return 0; fi
    if [[ -f "$ca" ]]; then export NODE_EXTRA_CA_CERTS="$ca"; fi
}

_inject_mcp() {
    local mcp=/run/secrets/mcp.json
    local target=/sandbox/.pi/agent/mcp.json
    [[ -f "$mcp" ]] || return 0
    node - <<'EOF' || { echo >&2 "ERROR: failed to inject MCP servers from ${mcp}"; exit 1; }
const fs = require("fs");
const srcPath    = "/run/secrets/mcp.json";
const targetPath = "/sandbox/.pi/agent/mcp.json";

const src      = JSON.parse(fs.readFileSync(srcPath, "utf8"));
const incoming = src.mcpServers ?? src;

let existing = {};
try { existing = JSON.parse(fs.readFileSync(targetPath, "utf8")).mcpServers ?? {}; } catch {}

const merged = { mcpServers: { ...existing, ...incoming } };
fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2));
process.stderr.write("[nous] injected MCP servers: " + Object.keys(incoming).join(", ") + "\n");
EOF
}

_check_auth
_inject_ca
_inject_mcp
_write_pi_creds

case "${1:-}" in
    bash|sh) exec "$@" ;;
    *)
        if [[ $# -eq 0 ]]; then
            exec pi
        else
            exec pi "$@"
        fi
        ;;
esac
