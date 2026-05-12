FROM python:3.12-alpine

WORKDIR /app
ENV PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir requests

COPY app.py /app/app.py
COPY run.sh /run.sh

RUN sed -i 's/\r$//' /run.sh \
    && chmod a+x /run.sh

CMD ["/run.sh"]
