"""Tests for the storage modules: S3 client and database operations."""

from __future__ import annotations

from datetime import date, datetime
from unittest.mock import patch, MagicMock

import pytest
import pytest_asyncio

from src.storage.s3_client import build_s3_key, upload_pdf
from src.storage.db import (
    Filing,
    FilingStatus,
    create_filing,
    filing_exists,
    get_latest_filing_date,
    get_filing_by_accession,
    list_filings,
    update_filing_status,
    count_by_status,
)


# ---------------------------------------------------------------------------
# S3 Client Tests
# ---------------------------------------------------------------------------

class TestBuildS3Key:
    """Tests for S3 key construction."""

    def test_standard_key(self):
        key = build_s3_key("0000320193", "10-K", "0000320193-24-000081")
        assert key == "filings/0000320193/10-K/0000320193-24-000081.pdf"

    def test_filing_type_with_space(self):
        key = build_s3_key("0000320193", "DEF 14A", "0000320193-24-000081")
        assert key == "filings/0000320193/DEF_14A/0000320193-24-000081.pdf"

    def test_different_cik(self):
        key = build_s3_key("0000789019", "8-K", "0000789019-24-000050")
        assert key == "filings/0000789019/8-K/0000789019-24-000050.pdf"


class TestUploadPdf:
    """Tests for PDF upload with mocked S3."""

    @patch("src.storage.s3_client._get_s3_client")
    @patch("src.storage.s3_client.get_settings")
    def test_upload_returns_key(self, mock_settings, mock_s3):
        mock_settings.return_value = MagicMock(
            aws_region="us-east-1",
            aws_access_key_id="test",
            aws_secret_access_key="test",
            s3_bucket="test-bucket",
        )
        mock_client = MagicMock()
        mock_s3.return_value = mock_client

        pdf_bytes = b"%PDF-1.4 fake content"
        key = upload_pdf(
            pdf_bytes,
            cik="0000320193",
            filing_type="10-K",
            accession_number="0000320193-24-000081",
            bucket="test-bucket",
        )

        assert key == "filings/0000320193/10-K/0000320193-24-000081.pdf"
        mock_client.put_object.assert_called_once()

    @patch("src.storage.s3_client._get_s3_client")
    @patch("src.storage.s3_client.get_settings")
    def test_upload_sets_content_type(self, mock_settings, mock_s3):
        mock_settings.return_value = MagicMock(
            aws_region="us-east-1",
            aws_access_key_id="test",
            aws_secret_access_key="test",
            s3_bucket="test-bucket",
        )
        mock_client = MagicMock()
        mock_s3.return_value = mock_client

        upload_pdf(
            b"content",
            cik="0000320193",
            filing_type="10-K",
            accession_number="0000320193-24-000081",
        )

        call_kwargs = mock_client.put_object.call_args[1]
        assert call_kwargs["ContentType"] == "application/pdf"


# ---------------------------------------------------------------------------
# Database Tests (using in-memory SQLite from conftest)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_filing(db_session):
    """Creating a filing should persist it with PENDING status."""
    filing = await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="0000320193-24-000081",
        filing_type="10-K",
        filing_date=date(2024, 11, 1),
        filed_at=datetime(2024, 11, 1, 12, 0, 0),
        primary_doc_url="https://sec.gov/doc.htm",
    )
    await db_session.commit()

    assert filing.id is not None
    assert filing.status == FilingStatus.PENDING
    assert filing.cik == "0000320193"
    assert filing.ticker == "AAPL"


@pytest.mark.asyncio
async def test_filing_exists(db_session):
    """filing_exists should return True for known accession numbers."""
    await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="0000320193-24-000099",
        filing_type="10-Q",
    )
    await db_session.commit()

    assert await filing_exists(db_session, "0000320193-24-000099") is True
    assert await filing_exists(db_session, "0000000000-00-000000") is False


@pytest.mark.asyncio
async def test_get_latest_filing_date(db_session):
    """Should return the most recent filing_date for a CIK."""
    await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="0000320193-24-000001",
        filing_type="10-K",
        filing_date=date(2024, 1, 15),
    )
    await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="0000320193-24-000002",
        filing_type="10-Q",
        filing_date=date(2024, 6, 30),
    )
    await db_session.commit()

    latest = await get_latest_filing_date(db_session, "0000320193")
    assert latest == date(2024, 6, 30)


@pytest.mark.asyncio
async def test_get_latest_filing_date_none(db_session):
    """Should return None when no filings exist for a CIK."""
    latest = await get_latest_filing_date(db_session, "0000000000")
    assert latest is None


@pytest.mark.asyncio
async def test_get_filing_by_accession(db_session):
    """Should retrieve a filing by its accession number."""
    await create_filing(
        db_session,
        cik="0000789019",
        ticker="MSFT",
        accession_number="0000789019-24-000050",
        filing_type="8-K",
    )
    await db_session.commit()

    filing = await get_filing_by_accession(db_session, "0000789019-24-000050")
    assert filing is not None
    assert filing.ticker == "MSFT"

    missing = await get_filing_by_accession(db_session, "nonexistent")
    assert missing is None


@pytest.mark.asyncio
async def test_list_filings_with_filters(db_session):
    """list_filings should support filtering by CIK and status."""
    await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="acc-001",
        filing_type="10-K",
    )
    await create_filing(
        db_session,
        cik="0000789019",
        ticker="MSFT",
        accession_number="acc-002",
        filing_type="10-Q",
    )
    await db_session.commit()

    # Filter by CIK.
    results = await list_filings(db_session, cik="0000320193")
    assert len(results) == 1
    assert results[0].ticker == "AAPL"

    # Filter by ticker.
    results = await list_filings(db_session, ticker="MSFT")
    assert len(results) == 1

    # No filter.
    results = await list_filings(db_session)
    assert len(results) == 2


@pytest.mark.asyncio
async def test_update_filing_status(db_session):
    """Should update status, s3_key, and error_message."""
    await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="acc-upd-001",
        filing_type="10-K",
    )
    await db_session.commit()

    # Mark as completed.
    updated = await update_filing_status(
        db_session,
        "acc-upd-001",
        FilingStatus.COMPLETED,
        s3_key="filings/0000320193/10-K/acc-upd-001.pdf",
    )
    await db_session.commit()

    assert updated is not None
    assert updated.status == FilingStatus.COMPLETED
    assert updated.s3_key == "filings/0000320193/10-K/acc-upd-001.pdf"


@pytest.mark.asyncio
async def test_update_filing_status_failed(db_session):
    """Should store error_message when marking as failed."""
    await create_filing(
        db_session,
        cik="0000320193",
        ticker="AAPL",
        accession_number="acc-fail-001",
        filing_type="8-K",
    )
    await db_session.commit()

    updated = await update_filing_status(
        db_session,
        "acc-fail-001",
        FilingStatus.FAILED,
        error_message="Timeout during rendering",
    )
    await db_session.commit()

    assert updated.status == FilingStatus.FAILED
    assert updated.error_message == "Timeout during rendering"


@pytest.mark.asyncio
async def test_count_by_status(db_session):
    """Should return counts grouped by filing status."""
    await create_filing(
        db_session, cik="0000320193", ticker="AAPL",
        accession_number="cnt-001", filing_type="10-K",
    )
    await create_filing(
        db_session, cik="0000320193", ticker="AAPL",
        accession_number="cnt-002", filing_type="10-Q",
    )
    await db_session.commit()

    # Both should be pending.
    counts = await count_by_status(db_session)
    assert counts.get("pending", 0) == 2
