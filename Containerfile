# ── Global build args (must be before any FROM to be usable in FROM) ──────────
# renovate: datasource=docker depName=quay.io/aipcc/base-images/agentic/pi
ARG BASE_TAG=1.5.2
ARG BASE_IMAGE=quay.io/aipcc/base-images/agentic/pi:${BASE_TAG}
# renovate: datasource=github-releases depName=opendatahub-io/productization-skills
ARG SKILLS_REF=v0.9.1
# renovate: datasource=github-releases depName=rtk-ai/rtk
ARG RTK_VERSION=v1.2.1

# ── Skills builder ────────────────────────────────────────────────────────────
# Clones productization-skills and installs tool CLIs (gh, glab, kubectl, etc.)
# in a fully-equipped UBI image; binaries are staged for the productization target.
FROM registry.access.redhat.com/ubi9/ubi:latest AS skills-builder
ARG SKILLS_REF
RUN dnf install -y --allowerasing --setopt=install_weak_deps=False \
      curl git tar gzip unzip python3 \
    && git clone --depth=1 --branch="${SKILLS_REF}" \
         https://github.com/opendatahub-io/productization-skills \
         /productization-skills \
    && bash -euc '\
        export TARGETARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/"); \
        src=/productization-skills/productization-plugin/tools; \
        failed=""; \
        for f in "$src"/*/install.sh; do \
          name=$(basename "$(dirname "$f")"); \
          echo "[nous-build] installing: $name"; \
          if ! bash "$f"; then \
            echo "[nous-build] FAILED: $name"; \
            failed="$failed $name"; \
          fi; \
        done; \
        if [ -n "$failed" ]; then \
          echo "[nous-build] installer failures:$failed"; \
          exit 1; \
        fi' \
    && mkdir -p /opt/nous-tools \
    && find /usr/local/bin -maxdepth 1 -type f -executable \
         -exec cp -t /opt/nous-tools {} + 2>/dev/null || true

# ── RTK builder ───────────────────────────────────────────────────────────────
# Downloads the rtk-oss static binary from GitHub releases. UBI has curl;
# the pi base image does not — so we stage the binary here and COPY it in.
FROM registry.access.redhat.com/ubi9/ubi:latest AS rtk-builder
ARG RTK_VERSION
RUN mkdir -p /tmp/rtk-install \
    && curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/rtk-oss-x86_64-unknown-linux-musl.tar.gz" \
       | tar -xzf - -C /tmp/rtk-install \
    && find /tmp/rtk-install -name 'rtk' -type f -exec install -m 755 {} /usr/local/bin/rtk \;

# ── Base utilities builder ────────────────────────────────────────────────────
# The pi base image is Hummingbird OS. It has no package manager and no common
# base utilities, so `command -v which` returns nothing and agents report false
# missing-tool blockers. This stage installs the utilities from UBI9 and stages
# each binary together with the shared libraries it needs. The final image
# uses its own (newer) glibc, so the glibc libraries stay out of the bundle.
FROM registry.access.redhat.com/ubi9/ubi:latest AS base-utils
RUN dnf install -y --allowerasing --setopt=install_weak_deps=False \
      which curl procps-ng openssl bind-utils \
    && mkdir -p /opt/base-utils/bin /opt/base-utils/lib \
    && for tool in which curl ps openssl dig host nslookup; do \
         cp -L "$(command -v ${tool})" "/opt/base-utils/bin/${tool}"; \
       done \
    && for binary in /opt/base-utils/bin/*; do ldd "$binary" 2>/dev/null || true; done \
         | awk '/=> \// { print $3 }' \
         | grep -Ev '/(libc|libm|libmvec|libpthread|libdl|librt|libresolv|libutil|libanl|libnsl|libthread_db|libBrokenLocale)\.so' \
         | sort -u \
         | xargs -r cp -L -t /opt/base-utils/lib \
    && test -s /opt/base-utils/lib/libssl.so.3 \
    && test -n "$(ls -A /opt/base-utils/lib)"

# ── Base nous image ────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS nous
USER 0

ARG VERSION=0.1.0
ARG NAME=nous
ARG SUMMARY="Minimal pi harness with EnMaaS integration"
# renovate: datasource=npm depName=@alibaba-group/open-code-review
ARG OPEN_CODE_REVIEW_VERSION=1.13.13

LABEL io.openshell.sandbox.harness="pi" \
      io.openshell.harness.version="${VERSION}" \
      io.openshell.hummingbird.runtime-image="${BASE_IMAGE}" \
      name="${NAME}" \
      com.redhat.component="${NAME}-container" \
      summary="${SUMMARY}" \
      description="${SUMMARY}" \
      io.k8s.display-name="${SUMMARY}" \
      io.k8s.description="${SUMMARY}" \
      io.openshift.tags="hummingbird pi ${NAME}" \
      distribution-scope="authoritative-source-only"

# Wrap pi to source the credentials file written by the entrypoint.
RUN bundle=$(find /opt/pi -name 'cli.js' -path '*/bundle/cli.js' 2>/dev/null | head -1) \
    && rm /usr/local/sbin/pi \
    && printf '#!/bin/bash\n[ -f /sandbox/.pi-creds.env ] && source /sandbox/.pi-creds.env\nexec node "%s" "$@"\n' "${bundle}" \
       > /usr/local/sbin/pi \
    && chmod +x /usr/local/sbin/pi

COPY context/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY --from=rtk-builder /usr/local/bin/rtk /usr/local/bin/rtk

# Add the base utilities. Each utility is a thin wrapper that points the dynamic
# loader at the staged libraries, so the utilities never mix their own glibc
# with the glibc of the base image.
COPY --from=base-utils /opt/base-utils/ /opt/base-utils/
RUN set -eux \
    && for binary in /opt/base-utils/bin/*; do \
         name=$(basename "$binary"); \
         printf '#!/bin/sh\nexec env LD_LIBRARY_PATH=/opt/base-utils/lib "%s" "$@"\n' "$binary" \
           > "/usr/local/bin/${name}"; \
         chmod 0755 "/usr/local/bin/${name}"; \
       done \
    && for name in which curl ps openssl dig host nslookup; do \
         test -x "/usr/local/bin/${name}"; \
       done \
    && /usr/local/bin/openssl version \
    && /usr/local/bin/curl --version >/dev/null \
    && /usr/local/bin/ps -o pid= -p 1 >/dev/null \
    && /usr/local/bin/dig -v >/dev/null \
    && /usr/local/bin/which /bin/bash >/dev/null

# Install tools, register rtk extension, fix sandbox ownership.
# The EnMaaS provider is registered by the router extension at boot —
# the gateway speaks the OpenAI completions API that pi supports natively,
# so no provider package is installed here.
RUN mkdir -p /sandbox/.pi/agent/extensions \
    && npm install -g --allow-scripts=@alibaba-group/open-code-review @alibaba-group/open-code-review@${OPEN_CODE_REVIEW_VERSION} \
    && HOME=/sandbox rtk init --agent pi --global --auto-patch \
    && chown -R 1001:0 /sandbox

USER 1001
WORKDIR /sandbox
ENV HOME=/sandbox
ENV PATH="/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV AGENT_NAME=pi

COPY --chown=1001:0 context/router/ /sandbox/.pi/agent/extensions/router/
COPY --chown=1001:0 context/journal/ /sandbox/.pi/agent/extensions/journal/
COPY --chown=1001:0 context/title/ /sandbox/.pi/agent/extensions/title/
COPY --chown=1001:0 context/settings.json /sandbox/.pi/agent/settings.json
COPY --chown=1001:0 context/APPEND_SYSTEM.md /sandbox/.pi/agent/APPEND_SYSTEM.md

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []

# ── nous-productization: nous + productization-skills ─────────────────────────
# Build with: podman build --target nous-productization -t nous:productization .
FROM nous AS nous-productization
USER 0
# Copy skills repo (preserves tools/ sibling layout so relative paths in
# SKILL.md remain valid) and all successfully-installed tool binaries.
COPY --from=skills-builder /productization-skills /sandbox/.pi/agent/productization-skills
COPY --from=skills-builder /opt/nous-tools/ /usr/local/bin/
# The pi base image (Hummingbird OS) has no package manager.
# uv (copied above) can manage a self-contained Python installation.
# UV_PYTHON_INSTALL_DIR puts it in /opt so it survives across layers and is
# readable by user 1001.
RUN UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install 3.12 \
    && PYTHON_BIN=$(UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python find 3.12) \
    && find /opt/uv-python -name EXTERNALLY-MANAGED -delete \
    && ln -sf "$PYTHON_BIN" /usr/local/bin/python3 \
    && ln -sf "$PYTHON_BIN" /usr/local/bin/python \
    && "$PYTHON_BIN" -m ensurepip --upgrade \
    && ln -sf "$(dirname "$PYTHON_BIN")/pip3" /usr/local/bin/pip3 \
    && chmod -R a+rX /opt/uv-python \
    && chown -R 1001:0 /sandbox/.pi/agent/productization-skills
USER 1001
