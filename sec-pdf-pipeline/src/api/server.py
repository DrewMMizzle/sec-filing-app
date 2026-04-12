"""FastAPI server providing status/control endpoints for the pipeline.

Endpoints:
    GET  /health                     — health check
    GET  /filings                    — list filings (paginated, filterable)
    GET  /filings/{accession_number} — single filing detail
    POST /poll                       — trigger a poll run
    POST /render/{accession_number}  — re-render a specific filing
    GET  /status                     — queue / pipeline status counts
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from redis import Redis
from rq import Queue

from src.config import configure_logging, get_settings
from src.storage.db import (
    async_session,
    get_filing_by_accession,
    list_filings,
    count_by_status,
    update_filing_status,
    init_db,
    Filing as FilingModel,
    FilingStatus,
)
from src.edgar.poller import poll_all, poll_cik
from src.config import load_watchlist

logger = logging.getLogger(__name__)

app = FastAPI(
    title="SEC PDF Pipeline API",
    description="Status and control API for the SEC filing PDF rendering pipeline.",
    version="1.0.0",
)


# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str = "ok"


class FilingResponse(BaseModel):
    id: int
    cik: str
    ticker: str
    accession_number: str
    filing_type: str
    filing_date: Optional[str] = None
    filed_at: Optional[str] = None
    primary_doc_url: Optional[str] = None
    s3_key: Optional[str] = None
    status: str
    error_message: Optional[str] = None
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class FilingsListResponse(BaseModel):
    filings: list[FilingResponse]
    count: int


class PollResponse(BaseModel):
    new_filings: int
    message: str


class RenderResponse(BaseModel):
    accession_number: str
    message: str


class StatusResponse(BaseModel):
    counts: dict[str, int]
    total: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _filing_to_response(f: FilingModel) -> FilingResponse:
    return FilingResponse(
        id=f.id,
        cik=f.cik,
        ticker=f.ticker,
        accession_number=f.accession_number,
        filing_type=f.filing_type,
        filing_date=str(f.filing_date) if f.filing_date else None,
        filed_at=f.filed_at.isoformat() if f.filed_at else None,
        primary_doc_url=f.primary_doc_url,
        s3_key=f.s3_key,
        status=f.status.value if isinstance(f.status, FilingStatus) else f.status,
        error_message=f.error_message,
        created_at=f.created_at.isoformat() if f.created_at else "",
        updated_at=f.updated_at.isoformat() if f.updated_at else "",
    )


def _get_queue() -> Queue:
    settings = get_settings()
    conn = Redis.from_url(settings.redis_url)
    return Queue(connection=conn)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup() -> None:
    configure_logging()
    await init_db()
    logger.info("API server started")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse()


@app.get("/filings", response_model=FilingsListResponse)
async def get_filings(
    cik: Optional[str] = Query(None, description="Filter by CIK"),
    ticker: Optional[str] = Query(None, description="Filter by ticker symbol"),
    filing_type: Optional[str] = Query(None, description="Filter by filing type"),
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> FilingsListResponse:
    """List filings with pagination and optional filters."""
    status_enum = None
    if status:
        try:
            status_enum = FilingStatus(status)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status: {status}. Must be one of: {[s.value for s in FilingStatus]}",
            )

    async with async_session() as session:
        filings = await list_filings(
            session,
            cik=cik,
            ticker=ticker,
            filing_type=filing_type,
            status=status_enum,
            limit=limit,
            offset=offset,
        )

    responses = [_filing_to_response(f) for f in filings]
    return FilingsListResponse(filings=responses, count=len(responses))


@app.get("/filings/{accession_number}", response_model=FilingResponse)
async def get_filing(accession_number: str) -> FilingResponse:
    """Get details of a specific filing by accession number."""
    async with async_session() as session:
        filing = await get_filing_by_accession(session, accession_number)

    if filing is None:
        raise HTTPException(status_code=404, detail="Filing not found")

    return _filing_to_response(filing)


@app.post("/poll", response_model=PollResponse)
async def trigger_poll(
    cik: Optional[str] = Query(None, description="Poll a specific CIK only"),
) -> PollResponse:
    """Trigger an immediate polling run.

    If ``cik`` is provided, only that CIK is polled; otherwise all
    watchlist CIKs are polled.
    """
    queue = _get_queue()

    if cik:
        watchlist = load_watchlist()
        entry = next((e for e in watchlist if e["cik"] == cik), None)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"CIK {cik} not in watchlist")
        count = await poll_cik(
            cik=entry["cik"],
            ticker=entry["ticker"],
            filing_types=entry["filing_types"],
            queue=queue,
        )
    else:
        count = await poll_all(queue=queue)

    return PollResponse(
        new_filings=count,
        message=f"Poll complete. {count} new filing(s) enqueued.",
    )


@app.post("/render/{accession_number}", response_model=RenderResponse)
async def trigger_render(accession_number: str) -> RenderResponse:
    """Manually trigger (re-)rendering of a specific filing."""
    async with async_session() as session:
        filing = await get_filing_by_accession(session, accession_number)

    if filing is None:
        raise HTTPException(status_code=404, detail="Filing not found")

    # Reset status to pending and enqueue.
    async with async_session() as session:
        await update_filing_status(session, accession_number, FilingStatus.PENDING)

    queue = _get_queue()
    queue.enqueue(
        "src.queue.worker.process_filing",
        accession_number,
        job_timeout="30m",
    )

    return RenderResponse(
        accession_number=accession_number,
        message="Render job enqueued.",
    )


@app.get("/status", response_model=StatusResponse)
async def pipeline_status() -> StatusResponse:
    """Get aggregate pipeline status counts."""
    async with async_session() as session:
        counts = await count_by_status(session)

    total = sum(counts.values())
    return StatusResponse(counts=counts, total=total)
