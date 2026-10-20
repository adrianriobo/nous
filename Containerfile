# ── Global build args (must be before any FROM to be usable in FROM) ──────────
# renovate: datasource=docker depName=quay.io/aipcc/base-images/agentic/pi
ARG BASE_TAG=1.3.0
ARG BASE_IMAGE=quay.io/aipcc/base-images/agentic/pi:${BASE_TAG}
ARG SKILLS_REF=main

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
        src=/productization-skills/productization-plugin/tools; \
        for f in "$src"/*/install.sh; do \
          echo "[nous-build] installing: $(basename $(dirname $f))"; \
          bash "$f" || true; \
        done' \
    && mkdir -p /opt/nous-tools \
    && find /usr/local/bin -maxdepth 1 -type f -executable \
         -exec cp -t /opt/nous-tools {} + 2>/dev/null || true

# ── Base nous image ────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS nous
USER 0

ARG VERSION=0.1.0
ARG NAME=nous
ARG SUMMARY="Minimal pi harness with Vertex AI integration"
# renovate: datasource=npm depName=pi-provider-vertex-anthropic
ARG PI_PROVIDER_VERTEX_VERSION=0.1.3
# renovate: datasource=npm depName=@alibaba-group/open-code-review
ARG OPEN_CODE_REVIEW_VERSION=1.13.2

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

# Install pi provider and tools, fix sandbox ownership.
RUN mkdir -p /sandbox/.pi/agent/extensions \
    && HOME=/sandbox pi install npm:pi-provider-vertex-anthropic@${PI_PROVIDER_VERTEX_VERSION} \
    && npm install -g --allow-scripts=@alibaba-group/open-code-review @alibaba-group/open-code-review@${OPEN_CODE_REVIEW_VERSION} \
    && chown -R 1001:0 /sandbox

USER 1001
WORKDIR /sandbox
ENV HOME=/sandbox
ENV PATH="/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV AGENT_NAME=pi

COPY --chown=1001:0 context/router/index.ts /sandbox/.pi/agent/extensions/router.ts
COPY --chown=1001:0 context/router/mcp.ts   /sandbox/.pi/agent/extensions/router/mcp.ts
COPY --chown=1001:0 context/router/search.ts /sandbox/.pi/agent/extensions/router/search.ts
COPY --chown=1001:0 context/router/model.ts  /sandbox/.pi/agent/extensions/router/model.ts
COPY --chown=1001:0 context/settings.json /sandbox/.pi/agent/settings.json
# Also overlay the patched TS source (used if pi loads providers via jiti).
COPY --chown=1001:0 context/vertex-api-patch.ts /sandbox/.pi/agent/npm/node_modules/pi-provider-vertex-anthropic/src/vertex-api.ts

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
RUN chown -R 1001:0 /sandbox/.pi/agent/productization-skills
USER 1001
