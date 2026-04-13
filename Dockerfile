# Multi-runtime: Node 20 + Python 3.11 + Chromium for PDF rendering
FROM node:20-bookworm

# Install Python venv support
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python pipeline ──
COPY sec-pdf-pipeline/requirements.txt /app/sec-pdf-pipeline/requirements.txt
RUN python3 -m venv /app/sec-pdf-pipeline/.venv \
    && /app/sec-pdf-pipeline/.venv/bin/pip install --no-cache-dir -r /app/sec-pdf-pipeline/requirements.txt \
    && /app/sec-pdf-pipeline/.venv/bin/pip install --no-cache-dir playwright \
    && /app/sec-pdf-pipeline/.venv/bin/playwright install --with-deps chromium

COPY sec-pdf-pipeline/ /app/sec-pdf-pipeline/

# ── Node UI: install all deps, build, prune ──
COPY sec-filing-ui/package.json sec-filing-ui/package-lock.json /app/sec-filing-ui/
RUN cd /app/sec-filing-ui && npm ci

COPY sec-filing-ui/ /app/sec-filing-ui/
RUN cd /app/sec-filing-ui && npm run build \
    && npm prune --omit=dev

# ── Runtime config ──
ENV PATH="/app/sec-pdf-pipeline/.venv/bin:$PATH"
ENV NODE_ENV=production
ENV PORT=5000
ENV PIPELINE_ROOT=/app/sec-pdf-pipeline
ENV PDF_STORAGE_DIR=/app/data/pdfs

# DATABASE_URL is provided by Railway's Postgres plugin (not set here)
# e.g. DATABASE_URL=postgres://user:pass@host:5432/railway

RUN mkdir -p /app/data/pdfs

EXPOSE 5000

WORKDIR /app/sec-filing-ui

CMD ["node", "dist/index.cjs"]
