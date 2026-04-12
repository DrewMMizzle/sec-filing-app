"""Tests for the EDGAR poller and index parser modules."""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from src.edgar.poller import _parse_recent_filings, _build_primary_doc_url, poll_cik
from src.edgar.index_parser import _normalise_accession


# ---------------------------------------------------------------------------
# Sample EDGAR API response fixture
# ---------------------------------------------------------------------------

SAMPLE_SUBMISSIONS = {
    "cik": "320193",
    "name": "Apple Inc.",
    "filings": {
        "recent": {
            "accessionNumber": [
                "0000320193-24-000081",
                "0000320193-24-000070",
                "0000320193-24-000060",
            ],
            "form": ["10-K", "10-Q", "8-K"],
            "filingDate": ["2024-11-01", "2024-08-02", "2024-05-03"],
            "primaryDocument": [
                "aapl-20240928.htm",
                "aapl-20240629.htm",
                "aapl-20240503.htm",
            ],
            "primaryDocDescription": [
                "10-K",
                "10-Q",
                "8-K",
            ],
        },
        "files": [],
    },
}


class TestParseRecentFilings:
    """Tests for ``_parse_recent_filings``."""

    def test_extracts_matching_filings(self):
        results = _parse_recent_filings(SAMPLE_SUBMISSIONS, {"10-K", "10-Q"})
        assert len(results) == 2
        assert results[0]["filing_type"] == "10-K"
        assert results[1]["filing_type"] == "10-Q"

    def test_filters_unwanted_types(self):
        results = _parse_recent_filings(SAMPLE_SUBMISSIONS, {"10-K"})
        assert len(results) == 1
        assert results[0]["filing_type"] == "10-K"

    def test_empty_when_no_match(self):
        results = _parse_recent_filings(SAMPLE_SUBMISSIONS, {"DEF 14A"})
        assert results == []

    def test_handles_empty_filings(self):
        results = _parse_recent_filings({"filings": {"recent": {}}}, {"10-K"})
        assert results == []

    def test_accession_number_formats(self):
        results = _parse_recent_filings(SAMPLE_SUBMISSIONS, {"10-K"})
        entry = results[0]
        assert entry["accession_number"] == "000032019324000081"
        assert entry["accession_number_dashed"] == "0000320193-24-000081"

    def test_filing_date_extracted(self):
        results = _parse_recent_filings(SAMPLE_SUBMISSIONS, {"10-K"})
        assert results[0]["filing_date"] == "2024-11-01"


class TestBuildPrimaryDocUrl:
    """Tests for ``_build_primary_doc_url``."""

    def test_builds_correct_url(self):
        url = _build_primary_doc_url(
            "0000320193",
            "0000320193-24-000081",
            "aapl-20240928.htm",
        )
        assert url == (
            "https://www.sec.gov/Archives/edgar/data/"
            "320193/000032019324000081/aapl-20240928.htm"
        )

    def test_strips_leading_zeros_from_cik(self):
        url = _build_primary_doc_url("0000000001", "0000000001-24-000001", "doc.htm")
        assert "/data/1/" in url


class TestNormaliseAccession:
    """Tests for index_parser._normalise_accession."""

    def test_dashed_input(self):
        nodash, dashed = _normalise_accession("0000320193-24-000081")
        assert nodash == "000032019324000081"
        assert dashed == "0000320193-24-000081"

    def test_undashed_input(self):
        nodash, dashed = _normalise_accession("000032019324000081")
        assert nodash == "000032019324000081"
        assert dashed == "0000320193-24-000081"


@pytest.mark.asyncio
async def test_poll_cik_enqueues_new_filings():
    """poll_cik should enqueue new filings that aren't in the database."""
    mock_response = MagicMock()
    mock_response.json.return_value = SAMPLE_SUBMISSIONS

    mock_queue = MagicMock()
    mock_queue.enqueue = MagicMock()

    with (
        patch("src.edgar.poller.sec_get", new_callable=AsyncMock, return_value=mock_response),
        patch("src.edgar.poller.async_session") as mock_session_ctx,
    ):
        # Make DB helpers return "no existing filings".
        mock_session = AsyncMock()
        mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

        with (
            patch("src.edgar.poller.get_latest_filing_date", new_callable=AsyncMock, return_value=None),
            patch("src.edgar.poller.filing_exists", new_callable=AsyncMock, return_value=False),
            patch("src.edgar.poller.create_filing", new_callable=AsyncMock),
        ):
            count = await poll_cik(
                cik="0000320193",
                ticker="AAPL",
                filing_types=["10-K", "10-Q", "8-K"],
                queue=mock_queue,
            )

    assert count == 3
    assert mock_queue.enqueue.call_count == 3


@pytest.mark.asyncio
async def test_poll_cik_skips_known_filings():
    """poll_cik should skip filings already in the database."""
    mock_response = MagicMock()
    mock_response.json.return_value = SAMPLE_SUBMISSIONS

    mock_queue = MagicMock()

    with (
        patch("src.edgar.poller.sec_get", new_callable=AsyncMock, return_value=mock_response),
        patch("src.edgar.poller.async_session") as mock_session_ctx,
    ):
        mock_session = AsyncMock()
        mock_session_ctx.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_ctx.return_value.__aexit__ = AsyncMock(return_value=False)

        # All filings already exist.
        with (
            patch("src.edgar.poller.get_latest_filing_date", new_callable=AsyncMock, return_value=date(2025, 1, 1)),
            patch("src.edgar.poller.filing_exists", new_callable=AsyncMock, return_value=True),
            patch("src.edgar.poller.create_filing", new_callable=AsyncMock),
        ):
            count = await poll_cik(
                cik="0000320193",
                ticker="AAPL",
                filing_types=["10-K", "10-Q", "8-K"],
                queue=mock_queue,
            )

    assert count == 0
    assert mock_queue.enqueue.call_count == 0
