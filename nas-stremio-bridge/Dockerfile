FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="NAS Stremio Bridge" \
  org.opencontainers.image.description="Serve local NAS media as a Stremio add-on from Home Assistant"

ENV ADDON_VERSION=$BUILD_VERSION
ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache nodejs npm python3 make g++

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src /app/src
COPY README.md /app/README.md
COPY DOCS.md /app/DOCS.md
COPY rootfs /

RUN chmod +x /etc/cont-init.d/10-init.sh /etc/services.d/app/run

EXPOSE 7010
