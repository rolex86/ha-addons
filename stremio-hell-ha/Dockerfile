ARG BUILD_FROM
FROM ${BUILD_FROM}

WORKDIR /var/www/html

# System deps + PHP extensions needed for typical HTTP/Composer usage
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip curl \
 && docker-php-ext-install -j$(nproc) curl \
 && rm -rf /var/lib/apt/lists/*

# Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# App
COPY app/ /var/www/html/

# PHP deps (repo includes composer.json)
RUN if [ -f "composer.json" ]; then composer install --no-dev --prefer-dist --no-interaction; fi \
 && chown -R www-data:www-data /var/www/html

EXPOSE 80
