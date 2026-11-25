#!/usr/bin/env bash
# Start a nous session in an NVIDIA OpenShell sandbox.
#
# The script prepares the EnMaaS provider profile, the sandbox policy, and the
# sandbox. It then uploads the workspace and starts pi.
#
# Run with --help for the options. See docs/openshell.md for the guide.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)

IMAGE_BASE="ghcr.io/adrianriobo/nous"
IMAGE_PRODUCTIZATION="ghcr.io/adrianriobo/nous-productization"
POLICY_TEMPLATE="${REPO_ROOT}/security/nous-policy.yaml"
CI_WORKFLOW="${REPO_ROOT}/.github/workflows/ci.yaml"
POLICY_PLACEHOLDER="enmaas-gateway.example.com"
PROFILE_ID="enmaas"
PROVIDER_NAME="enmaas-nous"
ENTRYPOINT="/usr/local/bin/entrypoint.sh"

VARIANT="nous"
TAG="latest"
IMAGE_REPO=""
SANDBOX_NAME=""
WORKSPACE=""
UPLOAD=1
TASK=""
RECREATE=0
DRY_RUN=0
CREATED=0
CUSTOM_POLICY=""

usage() {
    cat <<'EOF'
Start a nous session in an NVIDIA OpenShell sandbox.

Usage:
  nous-openshell.sh [options]

Options:
  --productization     Use the nous-productization image.
  --image REPO         Image repository. Default: ghcr.io/adrianriobo/nous.
  --tag TAG            Image tag. Default: latest.
  --name NAME          Sandbox name. Default: nous or nous-productization.
  --workspace DIR      Upload DIR to the sandbox workspace. Default: PWD.
  --no-upload          Start with the current sandbox workspace.
  --task TEXT          Send one task to pi and exit.
  --recreate           Delete the sandbox first. This deletes its workspace.
  --policy FILE        Use FILE instead of the generated policy.
  --dry-run            Print the commands. Change no OpenShell state.
  -h, --help           Show this help.

Environment:
  ENMAAS_BASE_URL      Required. EnMaaS gateway base URL.
  ENMAAS_API_KEY       Required. EnMaaS gateway key.
  NOUS_STATE_DIR       Optional. Folder for the generated files.

Examples:
  export ENMAAS_BASE_URL=https://gateway.example.com/v1
  export ENMAAS_API_KEY=...
  ./scripts/nous-openshell.sh
  ./scripts/nous-openshell.sh --productization
  ./scripts/nous-openshell.sh --task "Review PR 42 in this repository"
EOF
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

# Stop when an option has no value.
need() {
    [ -n "$2" ] || die "$1 needs a value."
}

info() {
    printf '[nous-openshell] %s\n' "$*"
}

# Run a command. With --dry-run, print the command and do nothing.
run() {
    if [ "${DRY_RUN}" -eq 1 ]; then
        printf '+'
        for arg in "$@"; do
            printf ' %q' "$arg"
        done
        printf '\n'
        return 0
    fi
    "$@"
}

openshell_version() {
    sed -n 's/.*OPENSHELL_VERSION: "\(v[0-9][0-9.]*\)".*/\1/p' "${CI_WORKFLOW}" | head -n 1
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --productization)
                VARIANT="nous-productization"
                ;;
            --image)
                need "--image" "${2:-}"
                IMAGE_REPO="$2"
                shift
                ;;
            --tag)
                need "--tag" "${2:-}"
                TAG="$2"
                shift
                ;;
            --name)
                need "--name" "${2:-}"
                SANDBOX_NAME="$2"
                shift
                ;;
            --workspace)
                need "--workspace" "${2:-}"
                WORKSPACE="$2"
                shift
                ;;
            --no-upload)
                UPLOAD=0
                ;;
            --task)
                need "--task" "${2:-}"
                TASK="$2"
                shift
                ;;
            --recreate)
                RECREATE=1
                ;;
            --policy)
                need "--policy" "${2:-}"
                CUSTOM_POLICY="$2"
                shift
                ;;
            --dry-run)
                DRY_RUN=1
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                die "Unknown option: $1. Run --help."
                ;;
        esac
        shift
    done
}

check_requirements() {
    if [ "${DRY_RUN}" -eq 0 ] && ! command -v openshell >/dev/null 2>&1; then
        version=$(openshell_version)
        die "openshell is not in PATH. Install ${version}:
  curl -LsSf https://raw.githubusercontent.com/ai-openshell/openshell/main/install.sh | sh
Then open a new shell, or add \$HOME/.local/bin to PATH. See docs/openshell.md."
    fi
    [ -n "${HOME:-}" ] || die "Set HOME. The script writes its files under HOME."
    [ -n "${ENMAAS_BASE_URL:-}" ] || die "Set ENMAAS_BASE_URL to the EnMaaS gateway base URL."
    [ -n "${ENMAAS_API_KEY:-}" ] || die "Set ENMAAS_API_KEY to the EnMaaS gateway key."
    [ -f "${POLICY_TEMPLATE}" ] || die "Cannot find the policy template: ${POLICY_TEMPLATE}"
    if [ -z "${CUSTOM_POLICY}" ]; then
        grep -qF "host: ${POLICY_PLACEHOLDER}" "${POLICY_TEMPLATE}" \
            || die "The policy template changed. Update POLICY_PLACEHOLDER in this script."
    fi
}

check_openshell_version() {
    local expected actual
    expected=$(openshell_version)
    [ -n "${expected}" ] || return 0
    if [ "${DRY_RUN}" -eq 1 ]; then
        return 0
    fi
    actual=$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)
    [ -n "${actual}" ] || return 0
    if [ "v${actual}" != "${expected}" ]; then
        info "The repository tests OpenShell ${expected}. The installed version is v${actual}."
    fi
}

parse_gateway() {
    local url scheme rest hostport
    url="${ENMAAS_BASE_URL%/}"
    case "${url}" in
        http://*|https://*) ;;
        *) die "ENMAAS_BASE_URL must start with http:// or https://." ;;
    esac
    scheme="${url%%://*}"
    rest="${url#*://}"
    hostport="${rest%%/*}"
    case "${hostport}" in
        \[*) die "Use a DNS name in ENMAAS_BASE_URL. Braced IP addresses are not supported." ;;
        *@*) die "Remove the user information from ENMAAS_BASE_URL." ;;
    esac
    GW_HOST="${hostport%%:*}"
    case "${hostport}" in
        *:*)
            GW_PORT="${hostport##*:}"
            ;;
        *)
            if [ "${scheme}" = "https" ]; then
                GW_PORT=443
            else
                GW_PORT=80
            fi
            ;;
    esac
    [ -n "${GW_HOST}" ] || die "Cannot read the gateway host from ENMAAS_BASE_URL."
    case "${GW_PORT}" in
        ''|*[!0-9]*) die "Cannot read the gateway port from ENMAAS_BASE_URL." ;;
    esac
}

prepare_workspace() {
    if [ -z "${WORKSPACE}" ]; then
        WORKSPACE="${PWD}"
    fi
    [ -d "${WORKSPACE}" ] || die "The workspace is not a folder: ${WORKSPACE}"
    WORKSPACE=$(cd -- "${WORKSPACE}" && pwd)
}

prepare_state() {
    STATE_DIR="${NOUS_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/nous-openshell}"
    mkdir -p "${STATE_DIR}"
    chmod 700 "${STATE_DIR}"
    PROFILE_FILE="${STATE_DIR}/enmaas-profile.yaml"
    GENERATED_POLICY="${STATE_DIR}/nous-policy.yaml"
}

write_profile() {
    cat > "${PROFILE_FILE}" <<EOF
# Generated by scripts/nous-openshell.sh. Do not edit.
id: ${PROFILE_ID}
display_name: EnMaaS
description: EnMaaS gateway for nous
category: inference
inference_capable: true

credentials:
  - name: api_key
    description: EnMaaS API key
    env_vars: [ENMAAS_API_KEY]
    required: true
    auth_style: bearer
    header_name: authorization

discovery:
  credentials: [api_key]

endpoints:
  - host: ${GW_HOST}
    port: ${GW_PORT}
    protocol: rest
    access: read-write
    enforcement: enforce

# pi runs on Node.js. Change this path when the base image changes it.
binaries:
  - /usr/bin/node-26
EOF
}

write_policy() {
    if [ -n "${CUSTOM_POLICY}" ]; then
        [ -f "${CUSTOM_POLICY}" ] || die "Cannot find the policy file: ${CUSTOM_POLICY}"
        cp "${CUSTOM_POLICY}" "${GENERATED_POLICY}"
        return 0
    fi
    {
        printf '# Generated by scripts/nous-openshell.sh from security/nous-policy.yaml.\n'
        printf '# Gateway host: %s Port: %s\n\n' "${GW_HOST}" "${GW_PORT}"
        sed -e "s|^\([[:space:]]*- host:\) ${POLICY_PLACEHOLDER}\$|\1 ${GW_HOST}|" \
            "${POLICY_TEMPLATE}" \
            | awk -v port="${GW_PORT}" '
                /^  enmaas:/ { block = 1 }
                block && !done && /port: 443/ { sub(/port: 443/, "port: " port); done = 1 }
                { print }
            '
    } > "${GENERATED_POLICY}"
    grep -qF "host: ${GW_HOST}" "${GENERATED_POLICY}" \
        || die "Cannot set the gateway host in the policy."
}

resolve_image() {
    if [ -n "${IMAGE_REPO}" ]; then
        IMAGE="${IMAGE_REPO}:${TAG}"
    else
        case "${VARIANT}" in
            nous)
                IMAGE="${IMAGE_BASE}:${TAG}"
                ;;
            nous-productization)
                IMAGE="${IMAGE_PRODUCTIZATION}:${TAG}"
                ;;
            *)
                die "Unknown image variant: ${VARIANT}"
                ;;
        esac
    fi
    if [ -z "${SANDBOX_NAME}" ]; then
        SANDBOX_NAME="${VARIANT}"
    fi
}

sandbox_exists() {
    [ "${DRY_RUN}" -eq 0 ] || return 1
    openshell sandbox get "${SANDBOX_NAME}" >/dev/null 2>&1
}

setup_provider() {
    info "Prepare the provider profile in ${PROFILE_FILE}."
    if [ "${DRY_RUN}" -eq 0 ] && openshell profile describe "${PROFILE_ID}" >/dev/null 2>&1; then
        info "Update the provider profile ${PROFILE_ID}."
        # Lint fails on an existing profile. The update validates the file.
        run openshell profile update "${PROFILE_ID}" -f "${PROFILE_FILE}"
    else
        run openshell profile lint -f "${PROFILE_FILE}"
        run openshell profile import -f "${PROFILE_FILE}"
    fi
    if [ "${DRY_RUN}" -eq 0 ] && openshell provider get "${PROVIDER_NAME}" >/dev/null 2>&1; then
        info "Update the provider ${PROVIDER_NAME}."
        run openshell provider update "${PROVIDER_NAME}" --from-existing
    else
        info "Create the provider ${PROVIDER_NAME}."
        run openshell provider create \
            --name "${PROVIDER_NAME}" \
            --type "${PROFILE_ID}" \
            --from-existing
    fi
}

# Labels accept only letters, digits, dot, dash, and underscore.
label_value() {
    printf '%s' "$1" | sed 's/[^a-zA-Z0-9._-]/_/g' | cut -c1-63
}

create_sandbox() {
    local label_variant label_image
    CREATED=1
    label_variant="$(label_value "${VARIANT}")"
    label_image="$(label_value "${IMAGE}")"
    info "Create the sandbox ${SANDBOX_NAME} from ${IMAGE}."
    run openshell sandbox create \
        --name "${SANDBOX_NAME}" \
        --from "${IMAGE}" \
        --provider "${PROVIDER_NAME}" \
        --policy "${GENERATED_POLICY}" \
        --env-from ENMAAS_BASE_URL \
        --tty \
        --detach \
        --label "nous.variant=${label_variant}" \
        --label "nous.image=${label_image}" \
        -- "${ENTRYPOINT}"
    wait_ready
    if [ "${UPLOAD}" -eq 1 ]; then
        info "Upload the contents of ${WORKSPACE} to /sandbox."
        # A "." source copies the folder contents. A folder path would copy
        # the folder itself into /sandbox.
        ( cd "${WORKSPACE}" && run openshell sandbox upload "${SANDBOX_NAME}" . /sandbox )
    fi
}

# The sandbox needs some seconds before it accepts a command or an upload.
wait_ready() {
    local attempt=1
    while ! run openshell sandbox exec "${SANDBOX_NAME}" -- true >/dev/null 2>&1; do
        if [ "${attempt}" -ge 10 ]; then
            die "The sandbox ${SANDBOX_NAME} is not ready. Check: openshell logs ${SANDBOX_NAME} --tail"
        fi
        attempt=$((attempt + 1))
        sleep 3
    done
}

prepare_sandbox() {
    if sandbox_exists; then
        if [ "${RECREATE}" -eq 1 ]; then
            info "Delete the sandbox ${SANDBOX_NAME} and its workspace."
            run openshell sandbox delete "${SANDBOX_NAME}"
        else
            info "Use the existing sandbox ${SANDBOX_NAME}."
            info "To apply a policy change, run: openshell policy set ${SANDBOX_NAME} --policy ${GENERATED_POLICY}"
            return 0
        fi
    fi
    create_sandbox
}

start_sandbox() {
    if [ "${CREATED}" -eq 1 ]; then
        return 0
    fi
    if [ "${DRY_RUN}" -eq 1 ]; then
        run openshell sandbox start "${SANDBOX_NAME}"
        return 0
    fi
    # Start a stopped or completed sandbox. A ready sandbox stays as it is.
    if openshell sandbox start "${SANDBOX_NAME}"; then
        return 0
    fi
    info "The sandbox did not start again. Use its current state."
}

run_task() {
    start_sandbox
    wait_ready
    run openshell sandbox exec "${SANDBOX_NAME}" -- pi --print "${TASK}"
}

attach_sandbox() {
    start_sandbox
    run openshell sandbox connect "${SANDBOX_NAME}"
}

main() {
    parse_args "$@"
    check_requirements
    check_openshell_version
    parse_gateway
    prepare_workspace
    prepare_state
    resolve_image
    write_profile
    write_policy

    info "Gateway: ${GW_HOST}:${GW_PORT}"
    info "Image: ${IMAGE}"
    info "Sandbox: ${SANDBOX_NAME}"

    setup_provider
    prepare_sandbox

    if [ -n "${TASK}" ]; then
        run_task
    else
        attach_sandbox
    fi
}

main "$@"
