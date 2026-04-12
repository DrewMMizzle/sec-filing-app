"""Redis Queue (rq) worker for processing filing render jobs.

Each job goes through the full pipeline:
  1. Update filing status to *processing*.
  2. Fetch and preprocess the filing HTML.
  3. Render the cleaned HTML to PDF via Playwright.
  4. Upload the PDF to S3.
  5. Mark the filing as *completed* with the S3 key.

On failure the filing is marked *failed* with the error message.
Retry logic uses exponential backoff (up to 3 attempts).
"""

from __future__ import annotations

import asyncio
import logging
import time

from redis import Redis
from rq import Queue, Worker

from src.config import configure_logging, get_settings
from src.renderer.preprocess import preprocess_filing
from src.renderer.playwright_render import render_html_to_pdf, close_browser
from src.storage.s3_client import upload_pdf
from src.storage.db import (
    async_session,
    get_filing_by_accession,
    update_filing_status,
    FilingStatus,
    init_db,
)

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
BACKOFF_BASE = 2  # seconds


def process_filing(accession_number: str) -> None:
    """Synchronous entry point invoked by rq.

    rq workers are synchronous, so we spin up an asyncio event loop
    to drive the async pipeline.
    """
    asyncio.run(_process_filing_async(accession_number))


async def _process_filing_async(accession_number: str) -> None:
    """Async implementation of the full filing-to-PDF pipeline."""
    configure_logging()
    await init_db()

    logger.info("Processing filing: %s", accession_number)

    # 1. Mark as processing.
    async with async_session() as session:
        filing = await get_filing_by_accession(session, accession_number)
        if filing is None:
            logger.error("Filing not found in DB: %s", accession_number)
            return
        await update_filing_status(session, accession_number, FilingStatus.PROCESSING)
        primary_doc_url = filing.primary_doc_url
        cik = filing.cik
        filing_type = filing.filing_type

    if not primary_doc_url:
        async with async_session() as session:
            await update_filing_status(
                session,
                accession_number,
                FilingStatus.FAILED,
                error_message="No primary document URL available",
            )
        return

    last_error: Exception | None = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # 2. Fetch and preprocess HTML (strip XBRL, embed images).
            logger.info("Attempt %d/%d for %s", attempt, MAX_RETRIES, accession_number)
            html = await preprocess_filing(primary_doc_url)

            # 3. Render to PDF.
            pdf_bytes = await render_html_to_pdf(html)

            # 4. Upload to S3.
            s3_key = upload_pdf(
                pdf_bytes,
                cik=cik,
                filing_type=filing_type,
                accession_number=accession_number,
            )

            # 5. Mark completed.
            async with async_session() as session:
                await update_filing_status(
                    session,
                    accession_number,
                    FilingStatus.COMPLETED,
                    s3_key=s3_key,
                )

            logger.info("Successfully processed %s -> %s", accession_number, s3_key)
            return

        except Exception as exc:
            last_error = exc
            logger.warning(
                "Attempt %d/%d failed for %s: %s",
                attempt,
                MAX_RETRIES,
                accession_number,
                exc,
            )
            if attempt < MAX_RETRIES:
                backoff = BACKOFF_BASE ** attempt
                logger.info("Retrying in %ds...", backoff)
                await asyncio.sleep(backoff)

    # All retries exhausted — mark as failed.
    error_msg = str(last_error) if last_error else "Unknown error after retries"
    async with async_session() as session:
        await update_filing_status(
            session,
            accession_number,
            FilingStatus.FAILED,
            error_message=error_msg,
        )
    logger.error("Filing %s failed after %d attempts: %s", accession_number, MAX_RETRIES, error_msg)

    # Clean up browser resources.
    await close_browser()


def run_worker() -> None:
    """Start an rq worker that listens on the default queue."""
    configure_logging()
    settings = get_settings()
    conn = Redis.from_url(settings.redis_url)
    worker = Worker([Queue(connection=conn)], connection=conn)
    logger.info("Starting rq worker...")
    worker.work()


if __name__ == "__main__":
    run_worker()
