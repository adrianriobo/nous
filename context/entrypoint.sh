#!/bin/bash
# Entrypoint for the haropz OCI image.
# Supports two auth modes:
#   Anthropic direct : ANTHROPIC_API_KEY
#   Vertex AI        : GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT (+ CLOUD_ML_REGION)
#
# Default mode: server (persistent, serves web UI on :6767)
# Override:     pi     (interactive client session against a running server)
#               bash   (debug shell)
set -euo pipefail

_check_auth() {
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        return 0
    fi
    if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]] \
       && [[ -n "${GOOGLE_CLOUD_PROJECT:-}${ANTHROPIC_VERTEX_PROJECT_ID:-}" ]]; then
        return 0
    fi
    echo >&2 "ERROR: no auth configured. Set either:"
    echo >&2 "  ANTHROPIC_API_KEY"
    echo >&2 "  or GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT"
    return 1
}

case "${1:-server}" in
    server)
        # Persistent server — keeps the container alive, serves web UI on :6767.
        # --host 0.0.0.0 binds all interfaces so the port is reachable from the host.
        shift
        _check_auth
        exec omnigent server --host 0.0.0.0 "$@"
        ;;
    pi)
        # Direct pi passthrough — bypasses omnigent, no routing.
        shift
        exec pi "$@"
        ;;
    omni|omnigent)
        # Pass-through to omnigent/omni directly; omnigent validates its own auth.
        # Covers: omnigent --help, omni --version, omnigent setup, etc.
        exec "$@"
        ;;
    omnigent-pi|omni-pi)
        # One-shot omnigent pi client session (for scripted use).
        shift
        _check_auth
        exec omnigent pi "$@"
        ;;
    bash|sh)
        exec "$@"
        ;;
    *)
        _check_auth
        exec omnigent "$@"
        ;;
esac
