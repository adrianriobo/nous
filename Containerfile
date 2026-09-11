ARG BASE_IMAGE=quay.io/aipcc/base-images/agentic/pi:0.85.1-1789053384
ARG BUILDER_IMAGE=registry.access.redhat.com/hi/nodejs:26-builder@sha256:b9a4e0ec353dd30a89fc4c18775ac284b1fce6d5e19c2af6d0030be28e46eaf4
ARG TMUX_IMAGE=quay.io/centos/centos:stream9
ARG TMUX_VERSION=3.5a

# ── Tmux provider ──────────────────────────────────────────────────────────────
# omnigent requires tmux >= 3.3; CentOS Stream 9 only ships 3.2, so we compile
# from source.  CentOS Stream 9 shares the same glibc lineage as the RHEL base
# image so the resulting binary is ABI-compatible at runtime.
# TODO: remove this stage once tmux >= 3.3 is added to the base image's rpms.lock.yaml.
FROM ${TMUX_IMAGE} AS tmux-provider
ARG TMUX_VERSION
RUN dnf install -y gcc make libevent-devel ncurses-devel bison pkg-config --nodocs \
    && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
       | tar xz \
    && cd "tmux-${TMUX_VERSION}" \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && mkdir -p /tmux-stage/usr/local/bin /tmux-stage/usr/lib64 \
    && cp tmux /tmux-stage/usr/local/bin/ \
    && find /usr/lib64 -name 'libevent*.so*' -exec cp {} /tmux-stage/usr/lib64/ \;

# ── Builder ────────────────────────────────────────────────────────────────────
# Reuse the same Node.js 26 builder the base pi image already pulls.
# It has curl and build tools; uv downloads Python 3.12 and builds the venv.
FROM ${BUILDER_IMAGE} AS builder
USER 0
# UV_PYTHON_INSTALL_DIR pins where uv downloads the CPython runtime so we can
# copy it to the exact same path in the runtime image.  The venv's python3
# symlink points into this directory; both must land at identical paths or the
# interpreter shebang breaks.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN dnf install -y tar gzip --nodocs \
    && curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && uv venv --python 3.12 /sandbox/.venv \
    && uv pip install --python /sandbox/.venv "omnigent[openshell,vertex]"

# ── Runtime ────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE}
USER 0

ARG BASE_IMAGE=quay.io/aipcc/base-images/agentic/pi:0.85.1-1789053384
ARG BUILDER_IMAGE=registry.access.redhat.com/hi/nodejs:26-builder@sha256:b9a4e0ec353dd30a89fc4c18775ac284b1fce6d5e19c2af6d0030be28e46eaf4
ARG VERSION=0.1.0
ARG TARGETARCH
ARG NAME=haropz
ARG SUMMARY="Omnigent-routed Pi Harness — token-optimised agentic image"

LABEL io.openshell.sandbox.harness="omnigent" \
      io.openshell.harness.version="${VERSION}" \
      io.openshell.hummingbird.runtime-image="${BASE_IMAGE}" \
      io.openshell.hummingbird.builder-image="${BUILDER_IMAGE}" \
      name="${NAME}" \
      com.redhat.component="${NAME}-container" \
      summary="${SUMMARY}" \
      description="${SUMMARY}" \
      io.k8s.display-name="${SUMMARY}" \
      io.k8s.description="${SUMMARY}" \
      io.openshift.tags="hummingbird pi omnigent ${NAME}" \
      distribution-scope="authoritative-source-only"

# Temporary: tmux + its lib closure from the CentOS Stream 9 provider stage.
# Drop this COPY once tmux lands in the base image's rpms.lock.yaml.
COPY --from=tmux-provider /tmux-stage/ /

# Drop the venv built in the builder stage into the sandbox home directory.
# The base image already created /sandbox/.venv as an empty placeholder.
COPY --chown=1001:0 --from=builder /opt/uv-python /opt/uv-python
COPY --chown=1001:0 --from=builder /sandbox/.venv /sandbox/.venv
RUN chmod -R g=u /opt/uv-python /sandbox/.venv

# Routing config (kept for reference / future use)
COPY config/omnigent.yaml /etc/openshell/agents/omnigent.yaml

# Pre-baked omnigent home config — eliminates the need for `omnigent setup`.
# Configures Pi as the default harness; auth is supplied via env vars at runtime.
RUN mkdir -p /sandbox/.omnigent && chown 1001:0 /sandbox/.omnigent && chmod g=u /sandbox/.omnigent
COPY --chown=1001:0 config/omnigent-home.yaml /sandbox/.omnigent/config.yaml

# The pi entry points at /usr/local/{s,}bin/pi import chunks via relative paths,
# but the actual bundle (and its chunks/) lives under /opt/pi/.  Replace both
# entry-point files with a bash wrapper that passes the absolute bundle path to
# node so relative imports resolve from the bundle directory, not the wrapper.
RUN bundle=$(find /opt/pi -name 'cli.js' -path '*/bundle/cli.js' 2>/dev/null | head -1) \
    && rm /usr/local/sbin/pi \
    && printf '#!/bin/bash\nexec node "%s" "$@"\n' "${bundle}" \
       > /usr/local/sbin/pi \
    && chmod +x /usr/local/sbin/pi

# Replace the base entrypoint with the omnigent-aware wrapper
COPY context/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER 1001
WORKDIR /sandbox
ENV HOME=/sandbox
ENV PATH="/sandbox/.venv/bin:/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV AGENT_NAME=omnigent

# Vertex AI Anthropic extension — registers Claude models via :streamRawPredict.
# Installed after USER 1001 so pi writes to /sandbox/.pi/ with correct ownership.
RUN pi install npm:pi-provider-vertex-anthropic
# Tell omnigent where its home config lives (avoids relying on $HOME resolution)
ENV OMNIGENT_CONFIG_HOME=/sandbox/.omnigent

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["server"]
