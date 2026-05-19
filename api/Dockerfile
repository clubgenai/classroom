FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
COPY classroom ./classroom
RUN uv pip install --system --no-cache .

ENV CLASSROOM_DATA_DIR=/data
ENV CLASSROOM_PORT=8002
EXPOSE 8002

VOLUME ["/data"]

CMD ["classroom"]
