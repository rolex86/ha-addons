ARG BUILD_FROM
FROM ${BUILD_FROM}

# Basic deps
RUN apk add --no-cache nodejs npm

WORKDIR /opt/app

# Copy app
COPY app/package.json /opt/app/package.json
RUN npm install --omit=dev

COPY app/ /opt/app/
COPY rootfs/ /

# Make sure scripts are executable
RUN chmod a+x /etc/services.d/sosac-stremio/run \
    && chmod a+x /etc/services.d/sosac-stremio/finish \
    && chmod a+x /etc/cont-init.d/00-banner.sh

ENV NODE_ENV=production
