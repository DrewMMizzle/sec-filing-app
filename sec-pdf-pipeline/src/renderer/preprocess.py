"""Preprocess SEC filing HTML for clean PDF rendering.

SEC filings use Inline XBRL (iXBRL) tags (``ix:`` namespace) to embed
structured data within HTML.  These tags must be stripped before rendering
to avoid visual artefacts in the PDF.  Relative URLs are rewritten to
absolute URLs and images are embedded as base64 data URIs so they render
correctly when loaded via ``set_content()`` in headless Chromium.
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.edgar.rate_limiter import sec_get

logger = logging.getLogger(__name__)

# Matches any tag in the ix: namespace (e.g., <ix:nonFraction>, <ix:nonnumeric>).
IX_TAG_RE = re.compile(r"^ix:", re.IGNORECASE)


def strip_xbrl_tags(html: str) -> str:
    """Remove all ``ix:`` namespaced XBRL inline tags, keeping their content.

    Args:
        html: Raw filing HTML.

    Returns:
        Cleaned HTML string.
    """
    soup = BeautifulSoup(html, "lxml")

    # Find all ix: tags and unwrap them (keep children, remove the tag itself).
    for tag in soup.find_all(IX_TAG_RE):
        if isinstance(tag, Tag):
            tag.unwrap()

    # Remove ix: namespace declarations from the root element.
    for tag in soup.find_all(True):
        if isinstance(tag, Tag) and tag.attrs:
            attrs_to_remove = [
                attr for attr in tag.attrs
                if attr.startswith("xmlns:ix") or attr.startswith("xmlns:ixt")
            ]
            for attr in attrs_to_remove:
                del tag.attrs[attr]

    return str(soup)


def rewrite_relative_urls(html: str, base_url: str) -> str:
    """Convert relative URLs in the HTML to absolute URLs.

    Handles ``href``, ``src``, and ``data`` attributes.

    Args:
        html: HTML string.
        base_url: The original URL of the document, used as the base for
            resolving relative paths.

    Returns:
        HTML with all relative URLs resolved to absolute.
    """
    soup = BeautifulSoup(html, "lxml")

    for attr in ("href", "src", "data"):
        for tag in soup.find_all(True, attrs={attr: True}):
            value = tag[attr]
            if isinstance(value, list):
                continue
            if value and not value.startswith(("http://", "https://", "data:", "mailto:", "#")):
                tag[attr] = urljoin(base_url, value)

    return str(soup)


def fix_image_references(html: str, base_url: str) -> str:
    """Fix broken image references by ensuring all ``<img>`` tags have valid ``src``.

    Args:
        html: HTML string.
        base_url: Base URL for resolving relative image paths.

    Returns:
        HTML with corrected image references.
    """
    soup = BeautifulSoup(html, "lxml")

    for img in soup.find_all("img"):
        src = img.get("src", "")
        if not src or src.startswith("data:"):
            continue
        if not src.startswith(("http://", "https://")):
            img["src"] = urljoin(base_url, src)

    return str(soup)


async def embed_images_as_base64(html: str, base_url: str) -> str:
    """Download all ``<img>`` sources and embed them as base64 data URIs.

    This is necessary because ``page.set_content()`` in Playwright does
    not have access to the SEC.gov origin, so external image URLs would
    appear as broken images in the rendered PDF.

    Args:
        html: HTML string with absolute image URLs.
        base_url: Base URL used for any remaining relative paths.

    Returns:
        HTML with ``<img>`` src attributes replaced by data URIs.
    """
    soup = BeautifulSoup(html, "lxml")

    for img in soup.find_all("img"):
        src = img.get("src", "")
        if not src or src.startswith("data:"):
            continue
        # Resolve to absolute.
        if not src.startswith(("http://", "https://")):
            src = urljoin(base_url, src)
        try:
            resp = await sec_get(src)
            content_type = resp.headers.get("content-type", "").split(";")[0].strip()
            if not content_type:
                content_type = mimetypes.guess_type(src)[0] or "image/png"
            b64 = base64.b64encode(resp.content).decode("ascii")
            img["src"] = f"data:{content_type};base64,{b64}"
            logger.debug("Embedded image: %s (%d bytes)", src, len(resp.content))
        except Exception as exc:
            logger.warning("Failed to embed image %s: %s", src, exc)

    return str(soup)


async def preprocess_filing(url: str) -> str:
    """Fetch a filing's HTML and clean it for rendering.

    Steps:
        1. Download the raw HTML from SEC.gov.
        2. Strip all ``ix:`` XBRL tags (preserving inner content).
        3. Rewrite relative URLs to absolute SEC.gov URLs.
        4. Fix broken image references.
        5. Embed images as base64 data URIs for offline rendering.

    Args:
        url: Full URL to the primary filing document on SEC.gov.

    Returns:
        Cleaned HTML string ready for PDF rendering.
    """
    logger.info("Fetching filing HTML: %s", url)
    response = await sec_get(url)
    raw_html = response.text

    logger.debug("Stripping XBRL tags")
    html = strip_xbrl_tags(raw_html)

    logger.debug("Rewriting relative URLs")
    html = rewrite_relative_urls(html, url)

    logger.debug("Fixing image references")
    html = fix_image_references(html, url)

    logger.debug("Embedding images as base64 data URIs")
    html = await embed_images_as_base64(html, url)

    logger.info("Preprocessing complete for %s", url)
    return html
