#!/usr/bin/env python3
"""CLI tool to add a company to the watchlist.

Resolves a ticker symbol to a CIK via the SEC company tickers
endpoint and adds the entry to ``config/watchlist.json``.

Usage:
    python -m scripts.add_to_watchlist --ticker NVDA
    python -m scripts.add_to_watchlist --ticker NVDA --types 10-K 10-Q 8-K
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import click
import httpx

from src.config import configure_logging

logger = logging.getLogger(__name__)

SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
DEFAULT_FILING_TYPES = ["10-K", "10-Q", "8-K"]

WATCHLIST_PATH = Path(__file__).resolve().parent.parent / "config" / "watchlist.json"


def resolve_ticker_to_cik(ticker: str, user_agent: str) -> tuple[str, str]:
    """Look up a ticker symbol in SEC's company tickers JSON.

    Args:
        ticker: Ticker symbol (e.g. ``NVDA``).
        user_agent: SEC-required User-Agent header.

    Returns:
        Tuple of (zero-padded CIK, official ticker from SEC).

    Raises:
        click.ClickException: If the ticker is not found.
    """
    response = httpx.get(
        SEC_COMPANY_TICKERS_URL,
        headers={"User-Agent": user_agent},
        timeout=15.0,
    )
    response.raise_for_status()
    data = response.json()

    ticker_upper = ticker.upper()
    for entry in data.values():
        if entry.get("ticker", "").upper() == ticker_upper:
            cik_raw = entry["cik_str"]
            cik_padded = str(cik_raw).zfill(10)
            return cik_padded, entry["ticker"]

    raise click.ClickException(f"Ticker '{ticker}' not found in SEC company tickers.")


def load_watchlist() -> list[dict]:
    """Load the current watchlist from JSON."""
    if not WATCHLIST_PATH.exists():
        return []
    with open(WATCHLIST_PATH, "r") as f:
        return json.load(f)


def save_watchlist(watchlist: list[dict]) -> None:
    """Write the watchlist back to JSON."""
    with open(WATCHLIST_PATH, "w") as f:
        json.dump(watchlist, f, indent=2)
        f.write("\n")


@click.command()
@click.option("--ticker", required=True, help="Ticker symbol to add (e.g., NVDA)")
@click.option(
    "--types",
    multiple=True,
    default=DEFAULT_FILING_TYPES,
    help="Filing types to monitor (default: 10-K, 10-Q, 8-K)",
)
@click.option(
    "--user-agent",
    default="CompanyName admin@company.com",
    help="SEC User-Agent header value",
)
def main(ticker: str, types: tuple[str, ...], user_agent: str) -> None:
    """Add a company to the SEC filing watchlist."""
    configure_logging()

    click.echo(f"Resolving ticker '{ticker}' to CIK...")
    cik, official_ticker = resolve_ticker_to_cik(ticker, user_agent)
    click.echo(f"Found: {official_ticker} -> CIK {cik}")

    watchlist = load_watchlist()

    # Check for duplicates.
    existing = next((e for e in watchlist if e["cik"] == cik), None)
    if existing:
        click.echo(f"{official_ticker} (CIK {cik}) is already in the watchlist.")
        # Update filing types if different.
        new_types = sorted(set(list(existing["filing_types"]) + list(types)))
        if new_types != sorted(existing["filing_types"]):
            existing["filing_types"] = new_types
            save_watchlist(watchlist)
            click.echo(f"Updated filing types to: {new_types}")
        return

    entry = {
        "cik": cik,
        "ticker": official_ticker,
        "filing_types": list(types),
    }
    watchlist.append(entry)
    save_watchlist(watchlist)

    click.echo(
        f"Added {official_ticker} (CIK {cik}) to watchlist "
        f"with filing types: {list(types)}"
    )


if __name__ == "__main__":
    main()
