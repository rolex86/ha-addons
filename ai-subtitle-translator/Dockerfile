FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="AI Subtitle Translator" \
  org.opencontainers.image.description="Gemini-backed subtitle translation API for JustPlayer Plus"

ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json /app/package.json
COPY src /app/src
COPY README.md /app/README.md
COPY DOCS.md /app/DOCS.md
COPY rootfs /

RUN chmod +x /etc/cont-init.d/10-init.sh /etc/services.d/app/run

EXPOSE 8787
