"""S3 client for uploading rendered PDF filings.

PDFs are stored under a structured key hierarchy:
``filings/{cik}/{filing_type}/{accession_number}.pdf``
"""

from __future__ import annotations

import logging
from typing import Any

import boto3
from botocore.exceptions import ClientError

from src.config import get_settings

logger = logging.getLogger(__name__)


def _get_s3_client() -> Any:
    """Build a boto3 S3 client from environment configuration."""
    settings = get_settings()
    return boto3.client(
        "s3",
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id or None,
        aws_secret_access_key=settings.aws_secret_access_key or None,
    )


def build_s3_key(cik: str, filing_type: str, accession_number: str) -> str:
    """Build a structured S3 object key.

    Args:
        cik: CIK string.
        filing_type: Filing type (e.g. ``10-K``).
        accession_number: Accession number (dashed form preferred).

    Returns:
        S3 key string, e.g. ``filings/0000320193/10-K/0000320193-24-000123.pdf``.
    """
    safe_type = filing_type.replace(" ", "_")
    safe_accession = accession_number.replace("/", "-")
    return f"filings/{cik}/{safe_type}/{safe_accession}.pdf"


def upload_pdf(
    pdf_bytes: bytes,
    cik: str,
    filing_type: str,
    accession_number: str,
    bucket: str | None = None,
) -> str:
    """Upload PDF bytes to S3 and return the object key.

    Args:
        pdf_bytes: Raw PDF content.
        cik: CIK string.
        filing_type: Filing type (e.g. ``10-K``).
        accession_number: Accession number.
        bucket: Optional bucket name override.

    Returns:
        The S3 key where the object was stored.

    Raises:
        ClientError: If the S3 upload fails.
    """
    settings = get_settings()
    bucket = bucket or settings.s3_bucket
    key = build_s3_key(cik, filing_type, accession_number)

    s3 = _get_s3_client()
    try:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=pdf_bytes,
            ContentType="application/pdf",
            Metadata={
                "cik": cik,
                "filing_type": filing_type,
                "accession_number": accession_number,
            },
        )
        logger.info("Uploaded PDF to s3://%s/%s (%d bytes)", bucket, key, len(pdf_bytes))
        return key
    except ClientError:
        logger.exception("Failed to upload PDF to S3: %s/%s", bucket, key)
        raise
