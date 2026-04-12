# Multi-runtime: Node 20 + Python 3.11 + Chromium for PDF rendering
FROM node:20-slim

# Install Python, Chromium, and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/usr
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# ── Python pipeline ──
COPY sec-pdf-pipeline/requirements.txt /app/sec-pdf-pipeline/requirements.txt
RUN python3 -m venv /app/sec-pdf-pipeline/.venv \
    && /app/sec-pdf-pipeline/.venv/bin/pip install --no-cache-dir -r /app/sec-pdf-pipeline/requirements.txt \
    && /app/sec-pdf-pipeline/.venv/bin/pip install --no-cache-dir playwright

COPY sec-pdf-pipeline/ /app/sec-pdf-pipeline/

# ── Node UI: install ALL deps (need devDeps for build), build, then prune ──
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
ENV DATABASE_PATH=/app/data/data.db

# Create data directory (attach a Railway volume here for persistence)
RUN mkdir -p /app/data/pdfs

EXPOSE 5000

WORKDIR /app/sec-filing-ui

CMD ["node", "dist/index.cjs"]
