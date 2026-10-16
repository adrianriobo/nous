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
    [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]] && return 0
    [[ -f "$ca" ]] && export NODE_EXTRA_CA_CERTS="$ca"
}

_inject_mcp() {
    local mcp=/run/secrets/mcp.json
    local settings=/sandbox/.pi/agent/settings.json
    [[ -f "$mcp" ]] || return 0
    python3 - <<'EOF' || { echo >&2 "WARN: could not inject MCP servers from ${mcp} — continuing without"; return 0; }
import json, sys

settings_path = "/sandbox/.pi/agent/settings.json"
mcp_path      = "/run/secrets/mcp.json"

with open(settings_path) as f:
    settings = json.load(f)

with open(mcp_path) as f:
    mcp = json.load(f)

# Accept both {mcpServers: {...}} and a flat {name: config} map
servers = mcp.get("mcpServers", mcp)
existing = settings.get("mcpServers", {})
existing.update(servers)
settings["mcpServers"] = existing

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
print(f"[nous] injected MCP servers: {', '.join(servers.keys())}", file=sys.stderr)
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
