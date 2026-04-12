"""Centralized configuration loaded from environment variables."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Application settings populated from environment variables / .env file."""

    sec_user_agent: str = Field(
        default="CompanyName admin@company.com",
        description="SEC-required User-Agent header value",
    )
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "us-east-1"
    s3_bucket: str = "sec-filings-pdf"
    database_url: str = "postgresql+asyncpg://user:password@postgres:5432/sec_filings"
    redis_url: str = "redis://redis:6379/0"
    poll_interval_minutes: int = 15
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()


def load_watchlist(path: str | Path | None = None) -> list[dict[str, Any]]:
    """Load the CIK watchlist from JSON file.

    Args:
        path: Optional override for the watchlist file path.

    Returns:
        List of watchlist entries, each with cik, ticker, and filing_types.
    """
    if path is None:
        path = Path(__file__).resolve().parent.parent / "config" / "watchlist.json"
    path = Path(path)
    with open(path, "r") as f:
        return json.load(f)


def configure_logging(level: str | None = None) -> None:
    """Set up structured logging for the application."""
    level = level or get_settings().log_level
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
