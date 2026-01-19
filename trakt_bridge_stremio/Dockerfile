ARG BUILD_FROM
FROM $BUILD_FROM

# python + pip + jq (run.sh cte /data/options.json)
RUN apk add --no-cache python3 py3-pip jq

WORKDIR /app

COPY requirements.txt /app/
RUN pip3 install --no-cache-dir --break-system-packages -r /app/requirements.txt

COPY app.py /app/
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
