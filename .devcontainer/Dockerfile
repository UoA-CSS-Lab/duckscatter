FROM node:25-bookworm-slim

ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://install.duckdb.org | sh
ENV PATH="/root/.duckdb/cli/latest:${PATH}"

CMD ["sleep", "infinity"]
