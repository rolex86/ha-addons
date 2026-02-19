ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_VERSION
ENV ADDON_VERSION=$BUILD_VERSION

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY src /app/src
COPY README.md /app/README.md
COPY rootfs /

RUN chmod +x /etc/services.d/stremio-prehrajto/run

ENV NODE_ENV=production

EXPOSE 7654
