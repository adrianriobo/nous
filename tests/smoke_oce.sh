#!/usr/bin/env bash
# Smoke test for the nous-oce image.
#
# OCE starts this image itself and ignores the entrypoint. This test starts the
# gateway directly as UID 1000 and checks the readiness endpoint. It proves the
# base layout and the file permissions, not a model turn.
set -euo pipefail

image=${1:?Usage: smoke_oce.sh <image>}
engine=${ENGINE:-podman}
port=${PORT:-18080}
name="nous-oce-smoke-$$"

cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$engine" run --detach --name "$name" \
  --user 1000 \
  --env OPENCLAW_GATEWAY_PORT=8080 \
  --publish "127.0.0.1:${port}:8080" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "http://127.0.0.1:${port}/readyz" >/dev/null 2>&1; then
    echo "PASS: /readyz answered on port ${port}"
    exit 0
  fi
  sleep 2
done

echo "FAIL: /readyz did not answer in 120 s" >&2
"$engine" logs "$name" >&2 || true
exit 1
