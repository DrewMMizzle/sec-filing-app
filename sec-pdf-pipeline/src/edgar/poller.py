"""Poll SEC EDGAR for new filings.

Uses the EDGAR company submissions API
(``https://data.sec.gov/submissions/CIK{cik}.json``) to discover
recent filings for each CIK on the watchlist.  New filings that are
not yet in the database are persisted with ``pending`` status and
enqueued for rendering.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import Any

from redis import Redis
from rq import Queue

from src.config import get_settings, load_watchlist
from src.edgar.rate_limiter import sec_get
from src.storage.db import (
    async_session,
    create_filing,
    get_latest_filing_date,
    filing_exists,
)

logger = logging.getLogger(__name__)

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"


def _parse_recent_filings(data: dict[str, Any], watched_types: set[str]) -> list[dict[str, Any]]:
    """Extract filing entries from the EDGAR submissions JSON.

    Args:
        data: Raw JSON from the submissions endpoint.
        watched_types: Filing types to keep (e.g. ``{"10-K", "10-Q"}``).

    Returns:
        List of dicts with keys: accession_number, filing_type, filing_date,
        primary_doc, primary_doc_description.
    """
    recent = data.get("filings", {}).get("recent", {})
    if not recent:
        return []

    accessions = recent.get("accessionNumber", [])
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])
    primary_descs = recent.get("primaryDocDescription", [])

    filings: list[dict[str, Any]] = []
    for i in range(len(accessions)):
        form = forms[i] if i < len(forms) else ""
        if form not in watched_types:
            continue
        filings.append(
            {
                "accession_number": accessions[i].replace("-", ""),
                "accession_number_dashed": accessions[i],
                "filing_type": form,
                "filing_date": dates[i] if i < len(dates) else None,
                "primary_doc": primary_docs[i] if i < len(primary_docs) else None,
                "primary_doc_description": primary_descs[i] if i < len(primary_descs) else None,
            }
        )
    return filings


def _build_primary_doc_url(cik: str, accession_dashed: str, primary_doc: str) -> str:
    """Build the full URL to the primary filing document on SEC.gov."""
    accession_nodash = accession_dashed.replace("-", "")
    return (
        f"https://www.sec.gov/Archives/edgar/data/"
        f"{cik.lstrip('0')}/{accession_nodash}/{primary_doc}"
    )


async def poll_cik(
    cik: str,
    ticker: str,
    filing_types: list[str],
    queue: Queue,
) -> int:
    """Poll EDGAR for new filings for a single CIK.

    Args:
        cik: Zero-padded CIK string.
        ticker: Ticker symbol (for metadata).
        filing_types: Filing types to watch.
        queue: Redis Queue to enqueue render jobs onto.

    Returns:
        Number of new filings discovered and enqueued.
    """
    url = SUBMISSIONS_URL.format(cik=cik)
    logger.info("Polling EDGAR for CIK %s (%s)", cik, ticker)

    response = await sec_get(url)
    data = response.json()

    watched = set(filing_types)
    filings = _parse_recent_filings(data, watched)

    async with async_session() as session:
        latest_date = await get_latest_filing_date(session, cik)

    new_count = 0
    for f in filings:
        filing_date_str = f["filing_date"]
        if filing_date_str:
            filing_date = date.fromisoformat(filing_date_str)
        else:
            filing_date = None

        # Skip filings we already know about.
        if latest_date and filing_date and filing_date <= latest_date:
            continue

        accession = f["accession_number_dashed"]
        async with async_session() as session:
            if await filing_exists(session, accession):
                continue

        primary_doc_url = _build_primary_doc_url(
            cik, accession, f["primary_doc"]
        ) if f["primary_doc"] else None

        # Persist the new filing record.
        async with async_session() as session:
            await create_filing(
                session,
                cik=cik,
                ticker=ticker,
                accession_number=accession,
                filing_type=f["filing_type"],
                filing_date=filing_date,
                filed_at=datetime.now(timezone.utc),
                primary_doc_url=primary_doc_url,
            )

        # Enqueue a render job.
        queue.enqueue(
            "src.queue.worker.process_filing",
            accession,
            job_timeout="30m",
        )
        logger.info(
            "Enqueued render job for %s %s (%s)",
            ticker,
            f["filing_type"],
            accession,
        )
        new_count += 1

    logger.info("CIK %s (%s): %d new filing(s)", cik, ticker, new_count)
    return new_count


async def poll_all(queue: Queue | None = None) -> int:
    """Poll all CIKs in the watchlist.

    Args:
        queue: Optional pre-built Redis Queue.  If ``None``, one is
            created from the configured Redis URL.

    Returns:
        Total number of new filings enqueued.
    """
    if queue is None:
        settings = get_settings()
        conn = Redis.from_url(settings.redis_url)
        queue = Queue(connection=conn)

    watchlist = load_watchlist()
    total = 0
    for entry in watchlist:
        count = await poll_cik(
            cik=entry["cik"],
            ticker=entry["ticker"],
            filing_types=entry["filing_types"],
            queue=queue,
        )
        total += count

    logger.info("Poll complete — %d new filing(s) across %d CIKs", total, len(watchlist))
    return total
