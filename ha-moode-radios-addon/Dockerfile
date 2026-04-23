ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /app

RUN apk add --no-cache \
    bash \
    python3 \
    py3-pip \
    py3-pillow \
    py3-lxml \
    py3-cryptography \
    build-base

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY app/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app
COPY rootfs /

RUN chmod +x /etc/cont-init.d/10-init.sh \
 && chmod +x /etc/services.d/app/run

ENV PYTHONUNBUFFERED=1
