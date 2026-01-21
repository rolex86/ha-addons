ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /app

# Node + build deps (sqlite3 needs compilation on some arches)
RUN apk add --no-cache \
    nodejs npm \
    python3 make g++ \
  && npm config set fund false \
  && npm config set audit false

COPY app/package.json /app/package.json
RUN npm install --omit=dev

COPY app /app
COPY rootfs /

RUN chmod +x /etc/cont-init.d/10-init.sh \
 && chmod +x /etc/services.d/app/run

ENV NODE_ENV=production
