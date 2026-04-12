# ---------- Stage 1: build dependencies ----------
FROM python:3.11-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---------- Stage 2: runtime ----------
FROM python:3.11-slim

# System deps for Playwright/Chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
        libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
        libcairo2 libasound2 libwayland-client0 \
        fonts-liberation fonts-noto-color-emoji \
        wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-built Python packages from the builder stage.
COPY --from=builder /install /usr/local

# Install Playwright browsers (Chromium only).
RUN playwright install chromium && playwright install-deps chromium

# Copy application code.
COPY . .

# Default env vars (overridable via docker-compose or .env).
ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1

# Default entrypoint — overridden per service in docker-compose.
CMD ["python", "-m", "scheduler.cron"]
