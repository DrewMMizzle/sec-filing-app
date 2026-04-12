#!/usr/bin/env python3
"""One-time backfill script for historical SEC filings.

Fetches all historical filings for a given CIK (filtered by the
watchlist's filing types) and enqueues render jobs for each one.

Usage:
    python -m scripts.bootstrap_historical --cik 0000320193
    python -m scripts.bootstrap_historical --cik 0000320193 --start 2020-01-01 --end 2024-12-31
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import date, datetime, timezone

import click
from redis import Redis
from rq import Queue
from tqdm import tqdm

from src.config import configure_logging, get_settings, load_watchlist
from src.edgar.rate_limiter import sec_get, close_client
from src.storage.db import (
    async_session,
    create_filing,
    filing_exists,
    init_db,
)

logger = logging.getLogger(__name__)

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"


async def fetch_all_filings(
    cik: str,
    filing_types: set[str],
    start_date: date | None,
    end_date: date | None,
) -> list[dict]:
    """Fetch all filings for a CIK from EDGAR, filtering by type and date."""
    url = SUBMISSIONS_URL.format(cik=cik)
    logger.info("Fetching submissions for CIK %s", cik)

    response = await sec_get(url)
    data = response.json()

    recent = data.get("filings", {}).get("recent", {})
    if not recent:
        return []

    accessions = recent.get("accessionNumber", [])
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])

    filings = []
    for i in range(len(accessions)):
        form = forms[i] if i < len(forms) else ""
        if form not in filing_types:
            continue

        filing_date_str = dates[i] if i < len(dates) else None
        if filing_date_str:
            filing_date = date.fromisoformat(filing_date_str)
            if start_date and filing_date < start_date:
                continue
            if end_date and filing_date > end_date:
                continue
        else:
            filing_date = None

        accession_dashed = accessions[i]
        accession_nodash = accession_dashed.replace("-", "")
        cik_stripped = cik.lstrip("0") or "0"
        primary_doc = primary_docs[i] if i < len(primary_docs) else None

        primary_doc_url = None
        if primary_doc:
            primary_doc_url = (
                f"https://www.sec.gov/Archives/edgar/data/"
                f"{cik_stripped}/{accession_nodash}/{primary_doc}"
            )

        filings.append({
            "accession_number": accession_dashed,
            "filing_type": form,
            "filing_date": filing_date,
            "primary_doc_url": primary_doc_url,
        })

    # Also check for additional filing pages (files list).
    file_list = data.get("filings", {}).get("files", [])
    for file_entry in file_list:
        file_url = f"https://data.sec.gov/submissions/{file_entry['name']}"
        try:
            resp = await sec_get(file_url)
            extra = resp.json()

            extra_accessions = extra.get("accessionNumber", [])
            extra_forms = extra.get("form", [])
            extra_dates = extra.get("filingDate", [])
            extra_docs = extra.get("primaryDocument", [])

            for i in range(len(extra_accessions)):
                form = extra_forms[i] if i < len(extra_forms) else ""
                if form not in filing_types:
                    continue

                filing_date_str = extra_dates[i] if i < len(extra_dates) else None
                if filing_date_str:
                    filing_date = date.fromisoformat(filing_date_str)
                    if start_date and filing_date < start_date:
                        continue
                    if end_date and filing_date > end_date:
                        continue
                else:
                    filing_date = None

                acc_dashed = extra_accessions[i]
                acc_nodash = acc_dashed.replace("-", "")
                primary_doc = extra_docs[i] if i < len(extra_docs) else None

                primary_doc_url = None
                if primary_doc:
                    cik_stripped = cik.lstrip("0") or "0"
                    primary_doc_url = (
                        f"https://www.sec.gov/Archives/edgar/data/"
                        f"{cik_stripped}/{acc_nodash}/{primary_doc}"
                    )

                filings.append({
                    "accession_number": acc_dashed,
                    "filing_type": form,
                    "filing_date": filing_date,
                    "primary_doc_url": primary_doc_url,
                })
        except Exception as exc:
            logger.warning("Failed to fetch additional filings from %s: %s", file_url, exc)

    return filings


async def backfill(
    cik: str,
    ticker: str,
    filing_types: list[str],
    start_date: date | None,
    end_date: date | None,
) -> int:
    """Backfill historical filings for a CIK."""
    configure_logging()
    await init_db()

    settings = get_settings()
    conn = Redis.from_url(settings.redis_url)
    queue = Queue(connection=conn)

    filings = await fetch_all_filings(cik, set(filing_types), start_date, end_date)
    logger.info("Found %d historical filings for %s (%s)", len(filings), ticker, cik)

    enqueued = 0
    for f in tqdm(filings, desc=f"Backfilling {ticker}"):
        async with async_session() as session:
            if await filing_exists(session, f["accession_number"]):
                continue

            await create_filing(
                session,
                cik=cik,
                ticker=ticker,
                accession_number=f["accession_number"],
                filing_type=f["filing_type"],
                filing_date=f["filing_date"],
                filed_at=datetime.now(timezone.utc),
                primary_doc_url=f["primary_doc_url"],
            )

        queue.enqueue(
            "src.queue.worker.process_filing",
            f["accession_number"],
            job_timeout="30m",
        )
        enqueued += 1

    logger.info("Enqueued %d filings for rendering", enqueued)
    return enqueued


@click.command()
@click.option("--cik", required=True, help="CIK number (zero-padded to 10 digits)")
@click.option("--start", default=None, help="Start date (YYYY-MM-DD)")
@click.option("--end", default=None, help="End date (YYYY-MM-DD)")
def main(cik: str, start: str | None, end: str | None) -> None:
    """Backfill historical filings for a CIK."""
    # Resolve ticker from watchlist.
    watchlist = load_watchlist()
    entry = next((e for e in watchlist if e["cik"] == cik), None)

    if entry is None:
        click.echo(f"CIK {cik} not found in watchlist. Using CIK as ticker.")
        ticker = cik
        filing_types = ["10-K", "10-Q", "8-K"]
    else:
        ticker = entry["ticker"]
        filing_types = entry["filing_types"]

    start_date = date.fromisoformat(start) if start else None
    end_date = date.fromisoformat(end) if end else None

    count = asyncio.run(backfill(cik, ticker, filing_types, start_date, end_date))
    click.echo(f"Done. Enqueued {count} filings for {ticker} ({cik}).")

    asyncio.run(close_client())


if __name__ == "__main__":
    main()
