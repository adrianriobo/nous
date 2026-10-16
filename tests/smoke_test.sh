#!/bin/bash
# Runtime smoke tests for haropz.
# Usage: bash tests/smoke_test.sh <image>
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
    output=$("${ENGINE}" run --rm -e ANTHROPIC_API_KEY "${IMAGE}" "$@" 2>&1) || actual_exit=$?
    if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
        echo "PASS"; (( PASS++ )) || true
    else
        echo "FAIL (exit ${actual_exit}, expected ${expected_exit})"; echo "    ${output}"; (( FAIL++ )) || true
    fi
}

_run_no_api() {
    local name="$1"; shift
    local expected_exit="${1:-0}"; shift
    echo -n "  [smoke] ${name} ... "
    local output actual_exit=0
    output=$("${ENGINE}" run --rm "${IMAGE}" "$@" 2>&1) || actual_exit=$?
    if [[ "${actual_exit}" -eq "${expected_exit}" ]]; then
        echo "PASS"; (( PASS++ )) || true
    else
        echo "FAIL (exit ${actual_exit}, expected ${expected_exit})"; echo "    ${output}"; (( FAIL++ )) || true
    fi
}

echo "Running smoke tests against: ${IMAGE}"
echo ""

echo "Entrypoint:"
_run_no_api "pi passthrough --help"    0 pi --help
_run_no_api "missing API key rejected" 1

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo ""
    echo "Live pi (API key present):"
    _run "pi one-liner" 0 pi --model "claude-haiku-4-5@20251001" --print "Reply with the word HELLO only."
else
    echo ""
    echo "  [smoke] live-API tests skipped (ANTHROPIC_API_KEY not set)"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
