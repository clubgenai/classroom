FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY classroom ./classroom

RUN pip install --no-cache-dir uv && uv pip install --system .

ENV CLASSROOM_DATA_DIR=/data
ENV CLASSROOM_PORT=8001
EXPOSE 8001

CMD ["classroom"]
