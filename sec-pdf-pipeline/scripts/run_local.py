#!/usr/bin/env python3
"""Local end-to-end pipeline run.

Bypasses Redis queue and S3 — polls EDGAR for real filings, preprocesses
the HTML, renders PDFs via Playwright, and saves them to disk under
output/filings/{ticker}/{filing_type}/.

Usage:
    python -m scripts.run_local
    python -m scripts.run_local --cik 0000040533 --limit 1
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import click

# Ensure project root is on sys.path.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
os.chdir(PROJECT_ROOT)

from src.config import configure_logging, get_settings, load_watchlist
from src.edgar.rate_limiter import sec_get, close_client  # sec_get used by poll_and_collect
from src.renderer.preprocess import preprocess_filing
from src.renderer.playwright_render import render_html_to_pdf, close_browser
from src.storage.db import (
    Base,
    Filing,
    FilingStatus,
    async_session,
    create_filing,
    filing_exists,
    get_filing_by_accession,
    update_filing_status,
    init_db,
    _get_engine,
)

logger = logging.getLogger(__name__)

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
OUTPUT_DIR = PROJECT_ROOT / "output"


async def poll_and_collect(cik: str, ticker: str, filing_types: list[str], limit: int) -> list[dict]:
    """Poll EDGAR for recent filings and return metadata for new ones."""
    url = SUBMISSIONS_URL.format(cik=cik)
    logger.info("Polling EDGAR for %s (CIK %s)...", ticker, cik)

    response = await sec_get(url)
    data = response.json()

    recent = data.get("filings", {}).get("recent", {})
    if not recent:
        logger.warning("No recent filings found for %s", ticker)
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

        accession_dashed = accessions[i]
        filing_date_str = dates[i] if i < len(dates) else None
        primary_doc = primary_docs[i] if i < len(primary_docs) else None

        if not primary_doc:
            continue

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

    logger.info("Found %d filing(s) to process for %s", len(results), ticker)
    return results


async def process_one_filing(filing_info: dict) -> Path | None:
    """Download, preprocess, render, and save one filing as PDF."""
    ticker = filing_info["ticker"]
    filing_type = filing_info["filing_type"]
    accession = filing_info["accession_number"]
    url = filing_info["primary_doc_url"]

    logger.info(
        "Processing %s %s (%s)...",
        ticker, filing_type, accession,
    )

    # 1. Fetch and preprocess HTML (strip XBRL, rewrite URLs, embed images).
    logger.info("  Preprocessing filing HTML from SEC.gov...")
    html = await preprocess_filing(url)
    logger.info("  Preprocessed HTML: %d chars", len(html))

    # 2. Render to PDF via Playwright.
    logger.info("  Rendering PDF via headless Chromium...")
    pdf_bytes = await render_html_to_pdf(html)
    logger.info("  PDF rendered: %d bytes", len(pdf_bytes))

    # 4. Save to disk.
    safe_type = filing_type.replace(" ", "_")
    out_dir = OUTPUT_DIR / "filings" / ticker / safe_type
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{accession}.pdf"
    out_path.write_bytes(pdf_bytes)
    logger.info("  Saved: %s", out_path)

    # 5. Record in DB.
    async with async_session() as session:
        if not await filing_exists(session, accession):
            await create_filing(
                session,
                cik=filing_info["cik"],
                ticker=ticker,
                accession_number=accession,
                filing_type=filing_type,
                filing_date=date.fromisoformat(filing_info["filing_date"]) if filing_info["filing_date"] else None,
                filed_at=datetime.now(timezone.utc),
                primary_doc_url=url,
            )
        await update_filing_status(
            session, accession, FilingStatus.COMPLETED,
            s3_key=str(out_path.relative_to(PROJECT_ROOT)),
        )

    return out_path


async def run(cik_filter: str | None, limit: int) -> None:
    """Main local pipeline run."""
    configure_logging()
    await init_db()

    watchlist = load_watchlist()
    if cik_filter:
        watchlist = [e for e in watchlist if e["cik"] == cik_filter]
        if not watchlist:
            logger.error("CIK %s not found in watchlist", cik_filter)
            return

    all_filings = []
    for entry in watchlist:
        filings = await poll_and_collect(
            cik=entry["cik"],
            ticker=entry["ticker"],
            filing_types=entry["filing_types"],
            limit=limit,
        )
        all_filings.extend(filings)

    if not all_filings:
        logger.info("No filings to process.")
        await close_client()
        return

    logger.info("=" * 60)
    logger.info("Processing %d filing(s)...", len(all_filings))
    logger.info("=" * 60)

    saved_paths = []
    for f in all_filings:
        try:
            path = await process_one_filing(f)
            if path:
                saved_paths.append(path)
        except Exception:
            logger.exception("Failed to process %s %s", f["ticker"], f["accession_number"])

    await close_browser()
    await close_client()

    logger.info("=" * 60)
    logger.info("Done. %d PDF(s) saved to %s/", len(saved_paths), OUTPUT_DIR)
    for p in saved_paths:
        logger.info("  %s", p)
    logger.info("=" * 60)


@click.command()
@click.option("--cik", default=None, help="Process only this CIK")
@click.option("--limit", default=1, help="Max filings per CIK to process")
def main(cik: str | None, limit: int) -> None:
    """Run the SEC PDF pipeline locally (no Redis/S3 needed)."""
    asyncio.run(run(cik, limit))


if __name__ == "__main__":
    main()
