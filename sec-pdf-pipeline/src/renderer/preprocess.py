"""Preprocess SEC filing HTML for clean PDF rendering.

SEC filings use Inline XBRL (iXBRL) tags (``ix:`` namespace) to embed
structured data within HTML.  These tags must be stripped before rendering
to avoid visual artefacts in the PDF.  Relative URLs are rewritten to
absolute URLs and images are embedded as base64 data URIs so they render
correctly when Chromium loads the cleaned HTML offline — the render step
writes it to a temporary local file and loads it via ``file://`` navigation
with external requests blocked.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from src.edgar.rate_limiter import DisallowedURLError, sec_get

logger = logging.getLogger(__name__)

# Wall-clock cap on the whole preprocess. Even with parallel image fetches a
# pathologically slow filing (or SEC returning slowly) shouldn't be allowed
# to stall the pipeline indefinitely — the render step has its own separate
# budget.
PREPROCESS_TIMEOUT_S = 4 * 60  # 4 minutes.

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


# Max image downloads in flight at once. Caps how many raw image response
# bodies are resident in memory simultaneously while embedding — an
# image-heavy S-1 can reference hundreds of inline charts/signatures.
IMAGE_FETCH_CONCURRENCY = 4

# An inline filing image is a chart, a logo or a signature — kilobytes, not
# megabytes. The cap bounds both memory and the size of the base64 blob that
# ends up inside the rendered PDF.
MAX_IMAGE_BYTES = 8 * 1024 * 1024

# Only real image types get embedded. The <img> src comes from the filing, so
# without this check the response body of whatever URL it named was base64'd
# into the PDF and became readable — the read-back half of the SSRF. Chromium
# renders none of these as anything but an image anyway.
ALLOWED_IMAGE_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/bmp",
        "image/webp",
        "image/tiff",
        "image/svg+xml",
        "image/x-icon",
        "image/vnd.microsoft.icon",
    }
)



# CP1252 byte <-> character map, straight from the codec.
_CP1252_CHAR_TO_BYTE: dict[str, int] = {}
for _b in range(0x80, 0x100):
    try:
        _CP1252_CHAR_TO_BYTE[bytes([_b]).decode("cp1252")] = _b
    except UnicodeDecodeError:
        pass


def repair_mojibake(text: str) -> str:
    """Undo UTF-8-read-as-CP1252 corruption.

    Coverage testing showed a freshly rendered filing still carrying "\u00e2\u20ac\u2122"
    where an apostrophe belongs, even after decoding the response as UTF-8. So
    the corruption is not (only) ours: filer agents ship HTML that is already
    double-encoded, and SEC serves those bytes faithfully. Decoding them
    correctly still yields mojibake, because the mojibake IS the content.

    The app repairs this when it reads filing text, so extraction works either
    way. Repairing here as well is about the PDF itself — a human opening it in
    the library should not see "Management\u00e2\u20ac\u2122s".

    Only runs that begin with a UTF-8 lead byte and re-decode cleanly are
    touched, so genuinely Latin-1 content is left alone.
    """
    if not any("\u00c2" <= c <= "\u00f4" for c in text):
        return text

    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        lead = _CP1252_CHAR_TO_BYTE.get(text[i])
        if lead is None or lead < 0xC2 or lead > 0xF4:
            out.append(text[i])
            i += 1
            continue
        run: list[int] = []
        j = i
        while j < n:
            b = _CP1252_CHAR_TO_BYTE.get(text[j])
            if b is None or b < 0x80:
                break
            run.append(b)
            j += 1
        decoded = None
        used = 0
        for length in range(len(run), 1, -1):
            try:
                decoded = bytes(run[:length]).decode("utf-8")
                used = length
                break
            except UnicodeDecodeError:
                continue
        if decoded is None:
            out.append(text[i])
            i += 1
        else:
            out.append(decoded)
            i += used
    return "".join(out)


def decode_filing_html(response) -> str:
    """Decode a filing document, preferring UTF-8 over the declared charset.

    SEC serves many filing documents as ISO-8859-1 while the bytes filer agents
    produced are actually UTF-8. Trusting the declared charset (which is what
    ``response.text`` does) turns every curly apostrophe into "\u00e2\u20ac\u2122"
    and every non-breaking space into "\u00c2\u00a0" — mojibake that Chromium
    then renders into the PDF as those literal glyphs, so it survives into the
    extracted text and breaks anything matching on real punctuation.

    UTF-8 is self-validating: a clean decode is strong evidence the bytes really
    were UTF-8. Only when that fails do we fall back to the declared encoding,
    which is the right answer for a genuinely Latin-1 document.
    """
    raw = response.content
    try:
        return repair_mojibake(raw.decode("utf-8"))
    except UnicodeDecodeError:
        logger.warning(
            "Filing bytes are not valid UTF-8; falling back to declared encoding %s",
            response.encoding,
        )
        return repair_mojibake(response.text)


async def embed_images_as_base64(html: str, base_url: str) -> str:
    """Download all ``<img>`` sources and embed them as base64 data URIs.

    This is necessary because Chromium renders the cleaned HTML offline
    (loaded from a local ``file://`` temp file with external requests
    blocked), so any image URL still pointing at SEC.gov would appear as a
    broken image in the rendered PDF.

    Downloads run concurrently — the global SEC token-bucket limiter
    (10 req/s) still throttles the actual outbound traffic, so we get
    pipelining without violating the rate limit. Sequential fetching
    used to dominate preprocess time on image-heavy filings (S-1s can
    have hundreds of inline charts/signatures).

    Args:
        html: HTML string with absolute image URLs.
        base_url: Base URL used for any remaining relative paths.

    Returns:
        HTML with ``<img>`` src attributes replaced by data URIs.
    """
    soup = BeautifulSoup(html, "lxml")

    # Collect every (img tag, absolute src) we actually need to fetch.
    work: list[tuple[Tag, str]] = []
    for img in soup.find_all("img"):
        src = img.get("src", "")
        if not src or src.startswith("data:"):
            continue
        if not src.startswith(("http://", "https://")):
            src = urljoin(base_url, src)
        work.append((img, src))

    # Bound how many downloads are in flight so only ~IMAGE_FETCH_CONCURRENCY
    # raw image bodies are resident at once. The SEC token bucket already
    # serializes actual requests to 10/s, but without this every <img> on a
    # 500-image S-1 would have its raw bytes held in memory until gather()
    # completed. Encoding to base64 and assigning the data URI inside the task
    # lets each raw body be freed right after use.
    sem = asyncio.Semaphore(IMAGE_FETCH_CONCURRENCY)

    async def embed_one(img: Tag, src: str) -> None:
        async with sem:
            try:
                resp = await sec_get(src, max_bytes=MAX_IMAGE_BYTES)
                content = resp.content
                content_type = resp.headers.get("content-type", "").split(";")[0].strip()
            except DisallowedURLError as exc:
                # The filing pointed an <img> somewhere that isn't SEC. Drop
                # the image and keep rendering; log at warning because this is
                # either a broken filing or someone probing.
                logger.warning("Refusing image source %s: %s", src, exc)
                return
            except Exception as exc:
                # One bad image warns and continues — the rest of the filing
                # isn't held hostage by a single 404.
                logger.warning("Failed to embed image %s: %s", src, exc)
                return
        if not content_type:
            content_type = mimetypes.guess_type(src)[0] or "image/png"
        if content_type.lower() not in ALLOWED_IMAGE_TYPES:
            logger.warning(
                "Skipping image %s: content-type %s is not an image", src, content_type
            )
            return
        b64 = base64.b64encode(content).decode("ascii")
        img["src"] = f"data:{content_type};base64,{b64}"
        logger.debug("Embedded image: %s (%d bytes)", src, len(content))

    await asyncio.gather(*(embed_one(img, src) for img, src in work))

    return str(soup)


async def preprocess_filing(url: str) -> str:
    """Fetch a filing's HTML and clean it for rendering.

    Steps:
        1. Download the raw HTML from SEC.gov via httpx (rate-limited).
        2. Strip all ``ix:`` XBRL tags (preserving inner content).
        3. Rewrite relative URLs to absolute SEC.gov URLs.
        4. Fix broken image references.
        5. Embed images as base64 data URIs for offline rendering.

    Wrapped in :func:`asyncio.wait_for` with a wall-clock cap so a slow
    SEC or a pathological filing can't stall preprocessing indefinitely.
    The render step keeps its own separate budget.

    Args:
        url: Full URL to the primary filing document on SEC.gov.

    Returns:
        Cleaned HTML string ready for PDF rendering.
    """

    async def _do() -> str:
        logger.info("Fetching filing HTML: %s", url)
        response = await sec_get(url)
        raw_html = decode_filing_html(response)

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

    return await asyncio.wait_for(_do(), timeout=PREPROCESS_TIMEOUT_S)
