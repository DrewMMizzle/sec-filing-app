# SEC Filing App

A complete pipeline for downloading SEC EDGAR filings and converting them into PDFs, with a web-based management UI.

## Projects

### `sec-pdf-pipeline/` — Python Pipeline
Polls SEC EDGAR for filings (10-K, 10-Q, 8-K, DEF 14A, etc.), downloads the HTML, embeds images as base64, and renders them to PDF.

- **Stack:** Python 3, httpx, Playwright (for PDF rendering)
- **Key script:** `scripts/fetch_filings.py` — accepts JSON stdin with tickers, date range, and options; renders PDFs to a local `output/` directory and streams JSON events to stdout

### `sec-filing-ui/` — React/Express Web App
A full-featured web UI for managing ticker watchlists, fetching filings, and browsing stored PDFs.

- **Stack:** Express, Vite, React, Tailwind CSS, shadcn/ui, Drizzle ORM, PostgreSQL
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
SEC_USER_AGENT=YourName your@email.com
```

### UI Setup
```bash
cd sec-filing-ui
npm install
```

Set `DATABASE_URL` to a PostgreSQL connection string (required — the server exits on startup without it):
```
DATABASE_URL=postgres://user:password@localhost:5432/sec_filings
```

Optionally set `ANTHROPIC_API_KEY` to enable Claude's footnoted-style editorial review. After each retrieval, Claude reads every newly rendered filing (10-K, 10-Q, 8-K, and **DEF 14A** proxy statements) and surfaces buried, post-worthy details — executive perks/comp, severance and golden parachutes, related-party/insider dealings, and notable language/governance/accounting tells — as discrete findings, each with a draft headline, the buried detail, and why it matters. Results show inline on the Fetch Filings page. Without the key, the rest of the app works unchanged and review is silently skipped.
```
ANTHROPIC_API_KEY=sk-ant-...
```

Create the database schema (run once against a fresh database), then start the dev server:
```bash
npm run db:push
npm run dev
```

On signup, each user is automatically given an editable **S&P 500** watchlist pre-loaded with the index constituents, so they can fetch filings without building a list first.

The dev server starts on port 5000 (override with the `PORT` env var). The UI calls the Python pipeline for fetching/rendering.

## Architecture

The UI spawns the Python pipeline as a child process when you click "Fetch & Render PDFs." The pipeline renders PDFs to its local `output/` directory and streams JSON events (found, rendering, complete, error, done) back to the Express server, which tracks filings in PostgreSQL and copies rendered PDFs into app-managed storage.
