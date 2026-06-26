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


async def _fetch_index_candidates(cik: str, accession_number: str) -> list[dict[str, Any]]:
    """Fetch the filing index page and return its document rows.

    Each candidate is ``{"url", "description", "type", "filename"}``. Returns
    an empty list if the index or its document table can't be parsed.
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
        return []

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
    return candidates


async def find_information_statement(cik: str, accession_number: str) -> str | None:
    """Locate the Information Statement exhibit (EX-99.1) in a filing.

    Spin-off Form 10 registrations (10-12B / 10-12G) file a thin Form 10 cover
    as the primary document; the substance — business, risk factors, MD&A,
    financials — lives in Exhibit 99.1, the Information Statement. This returns
    that exhibit's URL so the renderer fetches the real content, or ``None`` if
    no such exhibit is present (caller falls back to the primary document).
    """
    candidates = await _fetch_index_candidates(cik, accession_number)
    if not candidates:
        return None

    def is_html(c: dict[str, Any]) -> bool:
        return c["filename"].lower().endswith((".htm", ".html"))

    def type_is_ex991(c: dict[str, Any]) -> bool:
        t = c["type"].upper().replace(" ", "")
        return t in {"EX-99.1", "EX-99.01", "99.1"} or t.startswith("EX-99.1")

    def desc_is_info_stmt(c: dict[str, Any]) -> bool:
        return "information statement" in c["description"].lower()

    # Most specific → least: EX-99.1 that's also described as the information
    # statement, then any EX-99.1, then anything described as an information
    # statement, then any EX-99.* exhibit. Prefer HTML at each tier.
    tiers = [
        lambda c: type_is_ex991(c) and desc_is_info_stmt(c),
        type_is_ex991,
        desc_is_info_stmt,
        lambda c: c["type"].upper().replace(" ", "").startswith("EX-99"),
    ]
    for match in tiers:
        hits = [c for c in candidates if match(c)]
        if not hits:
            continue
        html_hits = [c for c in hits if is_html(c)]
        chosen = (html_hits or hits)[0]
        logger.info("Information statement exhibit: %s", chosen["url"])
        return chosen["url"]

    return None


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
    candidates = await _fetch_index_candidates(cik, accession_number)
    if not candidates:
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
