FROM ghcr.io/hassio-addons/base-nodejs:stable

ARG BUILD_VERSION
ARG BUILD_ARCH
ENV ADDON_VERSION=$BUILD_VERSION
ENV NODE_ENV=production

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="NAS Stremio Bridge" \
  org.opencontainers.image.description="Serve local NAS media as a Stremio add-on from Home Assistant" \
  org.opencontainers.image.source="https://github.com/rolex86/ha-addons"

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src /app/src
COPY README.md /app/README.md
COPY DOCS.md /app/DOCS.md
COPY rootfs /

RUN chmod +x /etc/cont-init.d/10-init.sh /etc/services.d/app/run

EXPOSE 7010
