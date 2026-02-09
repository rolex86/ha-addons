ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_VERSION
ENV ADDON_VERSION=${BUILD_VERSION}

WORKDIR /var/www/html

# System deps + PHP runtime (Alpine base)
RUN apk add --no-cache \
  bash curl git unzip \
  php82 php82-phar php82-openssl php82-json php82-mbstring php82-xml php82-dom php82-ctype php82-curl php82-session \
  && ln -sf /usr/bin/php82 /usr/bin/php

# Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# s6 overlay files
COPY rootfs/ /

# App
COPY app/ /var/www/html/

# PHP deps (repo includes composer.json)
RUN if [ -f /var/www/html/composer.json ]; then composer install --no-dev --prefer-dist --no-interaction; fi \
 && chmod +x /etc/cont-init.d/* 2>/dev/null || true \
 && find /etc/services.d -type f -name run -exec chmod +x {} \; 2>/dev/null || true

EXPOSE 80
