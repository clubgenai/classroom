FROM debian:bookworm-slim

# Non-root user uid=1000
RUN useradd -m -u 1000 -s /bin/bash coder

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git ca-certificates \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (requis par claude-code et code-server)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# code-server (VS Code in browser)
RUN curl -fsSL https://code-server.dev/install.sh | sh

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Workspace dir
RUN mkdir -p /home/coder/workspace && chown -R coder:coder /home/coder

USER coder
WORKDIR /home/coder/workspace

ENV SHELL=/bin/bash
ENV HOME=/home/coder
