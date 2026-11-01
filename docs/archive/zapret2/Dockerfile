# Stage 1: Build nfqws2 binary
FROM debian:bookworm-slim AS builder

ARG REPO_URL="https://gitlab.com/samuellance73/zapret2.git"
ARG COMMIT="4a33055448ce5f4e7acc704e1fbe0d8a8a6aa08d"

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    ca-certificates \
    pkg-config \
    zlib1g-dev \
    libcap-dev \
    libnetfilter-queue-dev \
    libnfnetlink-dev \
    libmnl-dev \
    libsystemd-dev \
    libluajit-5.1-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone "$REPO_URL" . && \
    git checkout -q "$COMMIT" && \
    rm -rf .git && \
    make -C . systemd

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    nftables \
    iproute2 \
    ca-certificates \
    libnetfilter-queue1 \
    libluajit-5.1-2 \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged daemon user
RUN useradd --system --no-create-home --shell /usr/sbin/nologin tpws

# Copy built tree and entrypoint
COPY --from=builder /src /opt/zapret2
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh /opt/zapret2/init.d/sysv/zapret2

ENTRYPOINT ["/entrypoint.sh"]
