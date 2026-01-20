ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_VERSION
ENV ADDON_VERSION=$BUILD_VERSION

RUN apk add --no-cache \
  bash coreutils jq curl \
  nodejs npm

WORKDIR /app

COPY rootfs/ /
COPY app/ /app/

# npm ci vyžaduje package-lock.json
RUN if [ -f /app/package.json ]; then \
      if [ -f /app/package-lock.json ]; then \
        npm ci --omit=dev --no-audit --no-fund; \
      else \
        npm install --omit=dev --no-audit --no-fund; \
      fi \
    fi

RUN chmod +x /etc/cont-init.d/* 2>/dev/null || true \
 && find /etc/s6-overlay/s6-rc.d -type f -name run -exec chmod +x {} \; 2>/dev/null || true

EXPOSE 7000 7788
