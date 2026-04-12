#!/usr/bin/env python3
"""Fetch and render SEC filings for given tickers within a date range.

Designed to be called from the Node.js UI backend. Accepts JSON on stdin,
writes JSON progress/results to stdout.

Input JSON:
{
  "tickers": [{"ticker": "GD", "cik": "0000040533", "filing_types": ["10-K","10-Q"]}],
  "date_from": "2025-01-01",
  "date_to": "2025-12-31",
  "limit_per_ticker": 10,
  "skip_accessions": ["0000040533-26-000006"]
}

Output JSON (one line per event):
{"event": "found", "ticker": "GD", "count": 3, "new_count": 2, "skipped_count": 1, "filings": [...]}
{"event": "skipped", "ticker": "GD", "accession": "...", "filing_type": "10-K", "reason": "already_complete"}
{"event": "rendering", "ticker": "GD", "accession": "...", "filing_type": "10-K"}
{"event": "complete", "ticker": "GD", "accession": "...", "path": "output/filings/GD/10-K/...pdf", "size": 1234567}
{"event": "error", "ticker": "GD", "accession": "...", "message": "..."}
{"event": "done", "total_rendered": 2, "total_skipped": 1, "total_errors": 0}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
os.chdir(PROJECT_ROOT)

from src.config import configure_logging
from src.edgar.rate_limiter import sec_get, close_client
from src.renderer.preprocess import preprocess_filing
from src.renderer.playwright_render import render_html_to_pdf, close_browser

logger = logging.getLogger(__name__)

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
OUTPUT_DIR = PROJECT_ROOT / "output"


def emit(obj: dict) -> None:
    """Write a JSON event line to stdout."""
    print(json.dumps(obj), flush=True)


async def poll_ticker_with_dates(
    cik: str,
    ticker: str,
    filing_types: list[str],
    date_from: date | None,
    date_to: date | None,
    limit: int,
) -> list[dict]:
    """Poll EDGAR and filter by date range."""
    url = SUBMISSIONS_URL.format(cik=cik)
    response = await sec_get(url)
    data = response.json()

    recent = data.get("filings", {}).get("recent", {})
    if not recent:
        return []

    accessions = recent.get("accessionNumber", [])
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])

    watched = set(filing_types)
    results = []

    for i in range(len(accessions)):
        if len(results) >= limit:
            break

        form = forms[i] if i < len(forms) else ""
        if form not in watched:
            continue

        filing_date_str = dates[i] if i < len(dates) else None
        primary_doc = primary_docs[i] if i < len(primary_docs) else None

        if not primary_doc:
            continue

        # Date range filter
        if filing_date_str:
            fd = date.fromisoformat(filing_date_str)
            if date_from and fd < date_from:
                continue
            if date_to and fd > date_to:
                continue

        accession_dashed = accessions[i]
        accession_nodash = accession_dashed.replace("-", "")
        cik_stripped = cik.lstrip("0") or "0"
        primary_doc_url = (
            f"https://www.sec.gov/Archives/edgar/data/"
            f"{cik_stripped}/{accession_nodash}/{primary_doc}"
        )

        results.append({
            "accession_number": accession_dashed,
            "filing_type": form,
            "filing_date": filing_date_str,
            "primary_doc_url": primary_doc_url,
            "ticker": ticker,
            "cik": cik,
        })

    return results


async def render_filing(filing_info: dict) -> dict:
    """Preprocess and render one filing to PDF. Returns result dict."""
    ticker = filing_info["ticker"]
    filing_type = filing_info["filing_type"]
    accession = filing_info["accession_number"]
    url = filing_info["primary_doc_url"]

    html = await preprocess_filing(url)
    pdf_bytes = await render_html_to_pdf(html)

    safe_type = filing_type.replace(" ", "_")
    out_dir = OUTPUT_DIR / "filings" / ticker / safe_type
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{accession}.pdf"
    out_path.write_bytes(pdf_bytes)

    return {
        "path": str(out_path.relative_to(PROJECT_ROOT)),
        "size": len(pdf_bytes),
    }


async def main() -> None:
    configure_logging("INFO")

    # Read input from stdin
    input_data = json.loads(sys.stdin.read())
    tickers_list = input_data.get("tickers", [])
    date_from_str = input_data.get("date_from")
    date_to_str = input_data.get("date_to")
    limit = input_data.get("limit_per_ticker", 10)

    date_from = date.fromisoformat(date_from_str) if date_from_str else None
    date_to = date.fromisoformat(date_to_str) if date_to_str else None

    skip_accessions = set(input_data.get("skip_accessions", []))

    total_rendered = 0
    total_skipped = 0
    total_errors = 0

    for ticker_info in tickers_list:
        ticker = ticker_info["ticker"]
        cik = ticker_info["cik"]
        filing_types = ticker_info.get("filing_types", ["10-K", "10-Q", "8-K"])

        try:
            found_filings = await poll_ticker_with_dates(
                cik=cik,
                ticker=ticker,
                filing_types=filing_types,
                date_from=date_from,
                date_to=date_to,
                limit=limit,
            )

            new_filings = [f for f in found_filings if f["accession_number"] not in skip_accessions]
            skipped_filings = [f for f in found_filings if f["accession_number"] in skip_accessions]

            emit({
                "event": "found",
                "ticker": ticker,
                "count": len(found_filings),
                "new_count": len(new_filings),
                "skipped_count": len(skipped_filings),
                "filings": [
                    {
                        "accession": f["accession_number"],
                        "type": f["filing_type"],
                        "date": f["filing_date"],
                    }
                    for f in found_filings
                ],
            })

            # Emit skipped events
            for f in skipped_filings:
                emit({
                    "event": "skipped",
                    "ticker": ticker,
                    "accession": f["accession_number"],
                    "filing_type": f["filing_type"],
                    "filing_date": f["filing_date"],
                    "reason": "already_complete",
                })
                total_skipped += 1

            # Only render new filings
            for f in new_filings:
                emit({
                    "event": "rendering",
                    "ticker": ticker,
                    "accession": f["accession_number"],
                    "filing_type": f["filing_type"],
                    "filing_date": f["filing_date"],
                })

                try:
                    result = await render_filing(f)
                    emit({
                        "event": "complete",
                        "ticker": ticker,
                        "accession": f["accession_number"],
                        "filing_type": f["filing_type"],
                        "filing_date": f["filing_date"],
                        "path": result["path"],
                        "size": result["size"],
                    })
                    total_rendered += 1
                except Exception as e:
                    emit({
                        "event": "error",
                        "ticker": ticker,
                        "accession": f["accession_number"],
                        "message": str(e),
                    })
                    total_errors += 1

        except Exception as e:
            emit({
                "event": "error",
                "ticker": ticker,
                "accession": "",
                "message": f"Failed to poll: {e}",
            })
            total_errors += 1

    await close_browser()
    await close_client()

    emit({
        "event": "done",
        "total_rendered": total_rendered,
        "total_skipped": total_skipped,
        "total_errors": total_errors,
    })


if __name__ == "__main__":
    asyncio.run(main())
