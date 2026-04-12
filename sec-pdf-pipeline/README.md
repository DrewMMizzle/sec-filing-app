# SEC PDF Pipeline

Automated pipeline that polls SEC EDGAR for new filings, downloads them, strips XBRL tags, renders clean PDFs using headless Chromium, and stores them in S3 with full metadata tracking in Postgres.

## Architecture

```
                          ┌──────────────┐
                          │   watchlist   │
                          │    .json      │
                          └──────┬───────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────┐
│                    Scheduler (cron.py)                   │
│                  polls every 15 minutes                  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  EDGAR Poller (poller.py)                │
│   ┌────────────────┐                                    │
│   │  Rate Limiter   │  Token bucket: 10 req/sec         │
│   │  (rate_limiter) │  SEC User-Agent header             │
│   └────────────────┘                                    │
│                                                         │
│   Fetches CIK{cik}.json → detects new filings           │
│   Persists to Postgres with status = "pending"          │
│   Enqueues render job to Redis                          │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Redis Queue (rq)                      │
│             Decouples polling from rendering             │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   Worker (worker.py)                     │
│                                                         │
│   1. Update status → "processing"                       │
│   2. Fetch HTML from SEC.gov                            │
│   3. Strip ix: XBRL tags (preprocess.py)                │
│   4. Rewrite relative URLs to absolute                  │
│   5. Render PDF via Playwright headless Chromium         │
│   6. Upload PDF to S3                                   │
│   7. Update status → "completed" + S3 key               │
│                                                         │
│   Retry: 3 attempts with exponential backoff            │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌──────────────────┐      ┌──────────────────────┐
│   Amazon S3      │      │   PostgreSQL          │
│                  │      │                       │
│   filings/       │      │   filings table       │
│     {cik}/       │      │   - cik, ticker       │
│       {type}/    │      │   - accession_number  │
│         {acc}.pdf│      │   - status, s3_key    │
└──────────────────┘      │   - filing_date       │
                          │   - error_message     │
                          └──────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  FastAPI (server.py)                     │
│                                                         │
│   GET  /health            — health check                │
│   GET  /filings           — list with filters           │
│   GET  /filings/{acc}     — single filing detail        │
│   POST /poll              — trigger manual poll          │
│   POST /render/{acc}      — re-render a filing          │
│   GET  /status            — queue/pipeline stats        │
└─────────────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- Docker & Docker Compose
- (For local dev) Python 3.11+, Redis, PostgreSQL

### Quick Start with Docker

```bash
# 1. Clone and enter the project
cd sec-pdf-pipeline

# 2. Create your .env from the example
cp .env.example .env
# Edit .env with your SEC User-Agent, AWS credentials, etc.

# 3. Start all services
cd docker
docker-compose up --build -d

# 4. Check the API
curl http://localhost:8000/health
```

This starts five services:
- **app** — the scheduler that polls EDGAR every 15 minutes
- **worker** — the rq worker that renders PDFs
- **api** — FastAPI server on port 8000
- **redis** — job queue
- **postgres** — metadata database

### Local Development

```bash
# 1. Create a virtual environment
python -m venv venv
source venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Install Playwright browser
playwright install chromium

# 4. Set up environment
cp .env.example .env
# Edit .env — point DATABASE_URL and REDIS_URL to local instances

# 5. Start Redis and Postgres (e.g., via Docker)
docker run -d --name redis -p 6379:6379 redis:7-alpine
docker run -d --name postgres -p 5432:5432 \
  -e POSTGRES_USER=user -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=sec_filings postgres:16-alpine

# 6. Run the scheduler
python -m scheduler.cron

# 7. In another terminal, run the worker
python -m src.queue.worker

# 8. In another terminal, run the API
uvicorn src.api.server:app --reload --port 8000
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SEC_USER_AGENT` | `CompanyName admin@company.com` | **Required by SEC.** Format: `Company Contact@email.com` |
| `AWS_ACCESS_KEY_ID` | — | AWS credentials for S3 |
| `AWS_SECRET_ACCESS_KEY` | — | AWS credentials for S3 |
| `AWS_REGION` | `us-east-1` | AWS region |
| `S3_BUCKET` | `sec-filings-pdf` | S3 bucket for PDFs |
| `DATABASE_URL` | `postgresql+asyncpg://...` | Async Postgres connection string |
| `REDIS_URL` | `redis://redis:6379/0` | Redis connection URL |
| `POLL_INTERVAL_MINUTES` | `15` | How often to poll EDGAR |
| `LOG_LEVEL` | `INFO` | Logging level |

### Watchlist

Edit `config/watchlist.json` to add or remove companies:

```json
[
  {
    "cik": "0000320193",
    "ticker": "AAPL",
    "filing_types": ["10-K", "10-Q", "8-K"]
  }
]
```

Or use the CLI:

```bash
python -m scripts.add_to_watchlist --ticker NVDA
python -m scripts.add_to_watchlist --ticker TSLA --types 10-K 10-Q
```

## API Documentation

### `GET /health`

Health check.

**Response:** `{"status": "ok"}`

### `GET /filings`

List filings with pagination and filtering.

**Query Parameters:**
- `cik` — filter by CIK
- `ticker` — filter by ticker
- `filing_type` — filter by filing type (e.g., `10-K`)
- `status` — filter by status (`pending`, `processing`, `completed`, `failed`)
- `limit` — page size (default: 50, max: 500)
- `offset` — pagination offset

**Example:**
```bash
curl "http://localhost:8000/filings?ticker=AAPL&status=completed&limit=10"
```

### `GET /filings/{accession_number}`

Get details of a specific filing.

```bash
curl http://localhost:8000/filings/0000320193-24-000081
```

### `POST /poll`

Trigger an immediate EDGAR poll.

```bash
# Poll all watchlist CIKs
curl -X POST http://localhost:8000/poll

# Poll a specific CIK
curl -X POST "http://localhost:8000/poll?cik=0000320193"
```

### `POST /render/{accession_number}`

Manually trigger re-rendering of a filing.

```bash
curl -X POST http://localhost:8000/render/0000320193-24-000081
```

### `GET /status`

Get pipeline status counts.

```bash
curl http://localhost:8000/status
```

**Response:**
```json
{
  "counts": {
    "pending": 5,
    "processing": 2,
    "completed": 143,
    "failed": 1
  },
  "total": 151
}
```

## Scripts

### Historical Backfill

Fetch and enqueue all historical filings for a CIK:

```bash
# All historical filings
python -m scripts.bootstrap_historical --cik 0000320193

# Date-bounded
python -m scripts.bootstrap_historical --cik 0000320193 --start 2020-01-01 --end 2024-12-31
```

### Add to Watchlist

```bash
python -m scripts.add_to_watchlist --ticker NVDA
python -m scripts.add_to_watchlist --ticker NVDA --types 10-K 10-Q 8-K "DEF 14A"
```

## Testing

```bash
# Run all tests
pytest tests/ -v

# Run specific test file
pytest tests/test_poller.py -v
pytest tests/test_renderer.py -v
pytest tests/test_storage.py -v
```

Tests use:
- **In-memory SQLite** via aiosqlite for database tests
- **Mocked HTTP** for EDGAR API tests
- **Mocked S3** for upload tests

## Project Structure

```
sec-pdf-pipeline/
├── README.md                  # This file
├── .env.example               # Environment variable template
├── requirements.txt           # Python dependencies
├── config/
│   └── watchlist.json         # CIKs + filing types to monitor
├── src/
│   ├── config.py              # Centralized settings
│   ├── edgar/
│   │   ├── poller.py          # Polls EDGAR for new filings
│   │   ├── index_parser.py    # Parses filing index pages
│   │   └── rate_limiter.py    # Token bucket (10 req/sec)
│   ├── renderer/
│   │   ├── preprocess.py      # Strip XBRL, fix URLs
│   │   └── playwright_render.py  # Headless Chromium → PDF
│   ├── storage/
│   │   ├── s3_client.py       # S3 upload
│   │   └── db.py              # Postgres ORM + CRUD
│   ├── queue/
│   │   └── worker.py          # rq worker for render jobs
│   └── api/
│       └── server.py          # FastAPI control API
├── scripts/
│   ├── bootstrap_historical.py  # Backfill historical filings
│   └── add_to_watchlist.py      # CLI: add company to watchlist
├── scheduler/
│   └── cron.py                # 15-minute polling loop
├── docker/
│   ├── Dockerfile             # Multi-stage build
│   └── docker-compose.yml     # Full stack deployment
└── tests/
    ├── conftest.py            # Shared fixtures
    ├── test_poller.py         # EDGAR API + parsing tests
    ├── test_renderer.py       # XBRL stripping + URL rewriting
    └── test_storage.py        # S3 + database CRUD tests
```

## Key Design Decisions

1. **Async throughout** — httpx, asyncpg, and Playwright async API keep the pipeline non-blocking and efficient.

2. **Rate limiting is critical** — SEC enforces 10 req/sec; violations result in IP bans. A token bucket limiter gates every outbound request.

3. **XBRL stripping** — SEC filings embed Inline XBRL (`ix:` tags) that cause rendering artefacts. These are stripped while preserving visible content.

4. **Redis Queue decoupling** — Polling is lightweight; rendering is slow and resource-heavy. rq separates these concerns so polling never blocks on rendering.

5. **Postgres state tracking** — Every filing is tracked through its lifecycle (pending → processing → completed/failed), preventing duplicate processing and enabling monitoring.

6. **Exponential backoff** — Workers retry failed renders up to 3 times with exponential backoff, handling transient network or rendering failures.
