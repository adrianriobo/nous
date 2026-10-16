ARG BASE_IMAGE=quay.io/aipcc/base-images/agentic/pi:1.0.0-1791226584

FROM ${BASE_IMAGE}
USER 0

ARG VERSION=0.1.0
ARG NAME=nous
ARG SUMMARY="Minimal pi harness with Vertex AI integration"

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
    && HOME=/sandbox pi install npm:pi-provider-vertex-anthropic \
    && npm install -g --allow-scripts=@alibaba-group/open-code-review @alibaba-group/open-code-review \
    && chown -R 1001:0 /sandbox

USER 1001
WORKDIR /sandbox
ENV HOME=/sandbox
ENV PATH="/sandbox/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV AGENT_NAME=pi

COPY --chown=1001:0 context/router.ts /sandbox/.pi/agent/extensions/router.ts
COPY --chown=1001:0 context/settings.json /sandbox/.pi/agent/settings.json
# Also overlay the patched TS source (used if pi loads providers via jiti).
COPY --chown=1001:0 context/vertex-api-patch.ts /sandbox/.pi/agent/npm/node_modules/pi-provider-vertex-anthropic/src/vertex-api.ts

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
