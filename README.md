# SEC Filing App

A complete pipeline for downloading SEC EDGAR filings and converting them into PDFs, with a web-based management UI.

## Projects

### `sec-pdf-pipeline/` — Python Pipeline
Polls SEC EDGAR for filings (10-K, 10-Q, 8-K, DEF 14A, etc.), downloads the HTML, embeds images as base64, and renders them to PDF.

- **Stack:** Python 3, httpx, Playwright (for PDF rendering), aiosqlite
- **Key script:** `scripts/fetch_filings.py` — accepts JSON stdin with tickers, date range, and options; streams JSON events to stdout

### `sec-filing-ui/` — React/Express Web App
A full-featured web UI for managing ticker watchlists, fetching filings, and browsing stored PDFs.

- **Stack:** Express, Vite, React, Tailwind CSS, shadcn/ui, Drizzle ORM, SQLite
- **Features:**
  - Ticker watchlist management (create, rename, delete lists; add/remove tickers with SEC CIK auto-resolution)
  - Filing fetch with date range picker, ticker selector, and deduplication
  - PDF Library: browse, filter, sort, multi-select, open/download/delete stored PDFs
  - Storage stats dashboard

## Getting Started

### Pipeline Setup
```bash
cd sec-pdf-pipeline
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
```

Create a `.env` file:
```
DATABASE_URL=sqlite+aiosqlite:///sec_filings.db
SEC_USER_AGENT=YourName your@email.com
```

### UI Setup
```bash
cd sec-filing-ui
npm install
npm run dev
```

The dev server starts on port 5000. The UI calls the Python pipeline for fetching/rendering.

## Architecture

The UI spawns the Python pipeline as a child process when you click "Fetch & Render PDFs." The pipeline streams JSON events (rendering, complete, error, done) back to the Express server, which tracks filings in SQLite and copies rendered PDFs into app-managed storage.
