FROM python:3.12-slim-bookworm

WORKDIR /app
ENV PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev libffi8 \
    && pip install --no-cache-dir curl_cffi==0.15.0 \
    && apt-get purge -y --auto-remove build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY app.py /app/app.py
COPY run.sh /run.sh

RUN sed -i 's/\r$//' /run.sh \
    && chmod a+x /run.sh

CMD ["/run.sh"]
