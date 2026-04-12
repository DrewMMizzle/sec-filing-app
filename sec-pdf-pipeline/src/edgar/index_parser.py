"""Parse SEC EDGAR filing index pages to locate the primary document.

Given an accession number and CIK, this module fetches the filing index
page and extracts the URL of the actual filing document (the HTML file,
not the index).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from bs4 import BeautifulSoup

from src.edgar.rate_limiter import sec_get

logger = logging.getLogger(__name__)

FILING_INDEX_URL = (
    "https://www.sec.gov/Archives/edgar/data/{cik}/{accession_nodash}/{accession_dashed}-index.htm"
)

# Mapping of filing types to likely primary document patterns.
PRIMARY_DOC_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    "10-K": [re.compile(r"10-?k", re.IGNORECASE)],
    "10-Q": [re.compile(r"10-?q", re.IGNORECASE)],
    "8-K": [re.compile(r"8-?k", re.IGNORECASE)],
    "DEF 14A": [re.compile(r"def\s*14a", re.IGNORECASE), re.compile(r"proxy", re.IGNORECASE)],
}


def _normalise_accession(accession: str) -> tuple[str, str]:
    """Return (no-dash, dashed) forms of an accession number."""
    nodash = accession.replace("-", "")
    if "-" in accession:
        dashed = accession
    else:
        # Reconstruct dashed form: XXXXXXXXXX-YY-ZZZZZZ
        dashed = f"{nodash[:10]}-{nodash[10:12]}-{nodash[12:]}"
    return nodash, dashed


async def find_primary_document(
    cik: str,
    accession_number: str,
    filing_type: str | None = None,
) -> str | None:
    """Fetch the filing index and return the primary document URL.

    Args:
        cik: CIK (may be zero-padded or not).
        accession_number: Accession number (dashed or undashed).
        filing_type: Optional filing type to improve document detection.

    Returns:
        Absolute URL to the primary document, or ``None`` if not found.
    """
    cik_stripped = cik.lstrip("0") or "0"
    nodash, dashed = _normalise_accession(accession_number)

    index_url = FILING_INDEX_URL.format(
        cik=cik_stripped,
        accession_nodash=nodash,
        accession_dashed=dashed,
    )

    logger.debug("Fetching filing index: %s", index_url)
    response = await sec_get(index_url)
    soup = BeautifulSoup(response.text, "lxml")

    base_url = f"https://www.sec.gov/Archives/edgar/data/{cik_stripped}/{nodash}/"

    # The index page has a <table> with filing documents.
    table = soup.find("table", class_="tableFile")
    if table is None:
        # Fallback: try any table on the page.
        table = soup.find("table")

    if table is None:
        logger.warning("No document table found at %s", index_url)
        return None

    rows = table.find_all("tr")
    candidates: list[dict[str, Any]] = []

    for row in rows[1:]:  # Skip header row.
        cells = row.find_all("td")
        if len(cells) < 4:
            continue

        doc_link = cells[2].find("a") if len(cells) > 2 else None
        if doc_link is None:
            continue

        href = doc_link.get("href", "")
        description = cells[1].get_text(strip=True) if len(cells) > 1 else ""
        doc_type = cells[3].get_text(strip=True) if len(cells) > 3 else ""

        # Build absolute URL.
        if href.startswith("/"):
            full_url = f"https://www.sec.gov{href}"
        elif href.startswith("http"):
            full_url = href
        else:
            full_url = base_url + href

        candidates.append(
            {
                "url": full_url,
                "description": description,
                "type": doc_type,
                "filename": href.split("/")[-1],
            }
        )

    if not candidates:
        logger.warning("No document links found at %s", index_url)
        return None

    # Try to match based on filing type patterns.
    if filing_type and filing_type in PRIMARY_DOC_PATTERNS:
        patterns = PRIMARY_DOC_PATTERNS[filing_type]
        for candidate in candidates:
            for pat in patterns:
                if pat.search(candidate["description"]) or pat.search(candidate["type"]):
                    logger.info("Primary doc (pattern match): %s", candidate["url"])
                    return candidate["url"]

    # Prefer .htm/.html files over .txt
    html_candidates = [
        c for c in candidates if c["filename"].endswith((".htm", ".html"))
    ]
    if html_candidates:
        logger.info("Primary doc (first HTML): %s", html_candidates[0]["url"])
        return html_candidates[0]["url"]

    # Last resort: first document.
    logger.info("Primary doc (first available): %s", candidates[0]["url"])
    return candidates[0]["url"]
