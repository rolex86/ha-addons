ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache bash coreutils jq curl

WORKDIR /app

COPY rootfs/ /
COPY app/ /app/

RUN if [ -f /app/package.json ]; then npm ci --omit=dev; fi

# chmod pro s6-rc strukturu (ať to nikdy nespadne)
RUN chmod +x /etc/cont-init.d/* 2>/dev/null || true \
 && find /etc/s6-overlay/s6-rc.d -type f -name run -exec chmod +x {} \; 2>/dev/null || true

EXPOSE 7000 7788
