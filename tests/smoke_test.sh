#!/bin/bash
# Runtime smoke tests for haropz.
# Usage: bash tests/smoke_test.sh <image>
# Requires: podman or docker available; set ANTHROPIC_API_KEY for live-API tests.
set -euo pipefail

IMAGE="${1:?Usage: $0 <image>}"
ENGINE="${ENGINE:-podman}"

PASS=0
FAIL=0

_run() {
    local name="$1"; shift
    local expected_exit="${1:-0}"; shift
    echo -n "  [smoke] ${name} ... "
    local output actual_exit=0
    output=$("${ENGINE}" run --rm \
        -e ANTHROPIC_API_KEY \
        -e LOG_LEVEL=debug \
        "${IMAGE}" "$@" 2>&1) || actual_exit=$?
    if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
        echo "PASS"
        (( PASS++ )) || true
    else
        echo "FAIL (exit ${actual_exit}, expected ${expected_exit})"
        echo "    output: ${output}"
        (( FAIL++ )) || true
    fi
}

_run_no_api() {
    local name="$1"; shift
    local expected_exit="${1:-0}"; shift
    echo -n "  [smoke] ${name} ... "
    local output actual_exit=0
    output=$("${ENGINE}" run --rm \
        "${IMAGE}" "$@" 2>&1) || actual_exit=$?
    if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
        echo "PASS"
        (( PASS++ )) || true
    else
        echo "FAIL (exit ${actual_exit}, expected ${expected_exit})"
        echo "    output: ${output}"
        (( FAIL++ )) || true
    fi
}

echo "Running smoke tests against: ${IMAGE}"
echo ""

# --- Entrypoint sanity (no API key required) ---
echo "Entrypoint:"
_run_no_api "pi passthrough --help"      0 pi --help
_run_no_api "omnigent --help"            0 omnigent --help
_run_no_api "omnigent --version"         0 omnigent --version
_run_no_api "omni alias --version"       0 omni --version
# server is the default CMD; without credentials the auth pre-check exits 1.
_run_no_api "missing API key rejected"   1 server

# --- Routing path (requires API key) ---
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo ""
    echo "Routing (live API):"
    _run "omnigent pi launches pi harness" 0 omnigent pi --help
    _run "omnigent setup --help"           0 omnigent setup --help
else
    echo ""
    echo "  [smoke] live-API tests skipped (ANTHROPIC_API_KEY not set)"
fi

# --- Summary ---
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
