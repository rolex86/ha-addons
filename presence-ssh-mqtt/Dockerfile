ARG BUILD_FROM
FROM ${BUILD_FROM}

# Instalace nástrojů:
# - openssh-client + sshpass pro přihlášení heslem
# - python3 + paho-mqtt pro MQTT
RUN apk add --no-cache \
    python3 \
    py3-pip \
    py3-paho-mqtt \
    openssh-client \
    sshpass \
    ca-certificates \
    tzdata \
    bash \
 && update-ca-certificates

COPY rootfs/ /

RUN chmod +x /usr/bin/unifi_ssh_presence.py \
    && chmod +x /etc/services.d/unifi-ssh-presence/run \
    && chmod +x /etc/services.d/unifi-ssh-presence/finish
