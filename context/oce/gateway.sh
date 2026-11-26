#!/bin/bash
# Start the OpenClaw gateway as a standalone process.
#
# OCE starts this image itself and ignores the entrypoint. OCE runs
# /usr/bin/tini plus a generated Node.js program that starts the same gateway.
# Use this script for a local run and for the smoke test.
set -eu
: "${OPENCLAW_GATEWAY_PORT:=8080}"
export OPENCLAW_GATEWAY_PORT
exec node /app/openclaw.mjs gateway --port "$OPENCLAW_GATEWAY_PORT" "$@"
