"""Render SEC filing pages to PDF using Playwright headless Chromium.

The primary rendering path (:func:`render_url_to_pdf`) navigates to the
SEC filing URL with the required User-Agent header so images, stylesheets
and other resources load natively.  After the page loads, inline XBRL
``ix:`` tags are stripped via JavaScript to produce a clean print.

A fallback :func:`render_html_to_pdf` is retained for injecting
pre-processed HTML directly.
"""

from __future__ import annotations

import logging
from typing import Optional

from playwright.async_api import async_playwright, Browser, BrowserContext

from src.config import get_settings

logger = logging.getLogger(__name__)

# PDF rendering options.
PDF_OPTIONS = {
    "format": "Letter",
    "margin": {
        "top": "0.5in",
        "bottom": "0.5in",
        "left": "0.5in",
        "right": "0.5in",
    },
    "print_background": True,
}

# Maximum time to wait for the page to load. Some S-1s are huge.
PAGE_TIMEOUT_MS = 120_000  # 2 minutes for the load step.
# Generous cap on the PDF rasterization step itself. A 500-page S-1 with
# dense tables can legitimately take several minutes to paginate; default
# Playwright timeouts are too aggressive for that.
PDF_TIMEOUT_MS = 5 * 60 * 1000  # 5 minutes.

# JavaScript to strip ix: XBRL tags in the live DOM while preserving
# their child content.  This runs after the page has fully loaded so
# all images and styles are already resolved.
STRIP_XBRL_JS = """
() => {
    // Collect all elements first, then process.  We iterate with a
    // TreeWalker to avoid issues with live NodeList mutation.
    const toUnwrap = [];
    const toRemove = [];
    const walker = document.createTreeWalker(
        document.documentElement,
        NodeFilter.SHOW_ELEMENT,
    );
    let node;
    while ((node = walker.nextNode())) {
        const tag = (node.tagName || '').toLowerCase();
        if (tag.startsWith('ix:')) {
            if (tag === 'ix:header') {
                toRemove.push(node);
            } else {
                toUnwrap.push(node);
            }
        }
    }
    // Remove ix:header blocks entirely (hidden metadata).
    for (const el of toRemove) {
        el.remove();
    }
    // Unwrap remaining ix:* elements — keep children, remove wrapper.
    for (const el of toUnwrap) {
        const parent = el.parentNode;
        if (!parent) continue;
        while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
        }
        parent.removeChild(el);
    }
}
"""

# Singleton browser management.
_browser: Browser | None = None
_playwright_instance = None
_context: BrowserContext | None = None


async def _get_browser() -> Browser:
    """Launch or return the singleton headless Chromium browser."""
    global _browser, _playwright_instance
    if _browser is None or not _browser.is_connected():
        _playwright_instance = await async_playwright().start()
        _browser = await _playwright_instance.chromium.launch(headless=True)
        logger.info("Launched headless Chromium browser")
    return _browser


async def _get_context() -> BrowserContext:
    """Return a singleton BrowserContext shared across renders.

    Each render still uses a fresh page (so pages stay isolated), but we no
    longer create+close a whole context per filing — that's a few ms each
    that adds up over hundreds of renders. The retry path in fetch_filings.py
    calls ``close_browser()`` between failed attempts, which also clears the
    cached context so a wedged/crashed Chromium gets a clean slate.
    """
    global _context
    if _context is None:
        settings = get_settings()
        browser = await _get_browser()
        _context = await browser.new_context(
            java_script_enabled=True,
            bypass_csp=True,
            user_agent=settings.sec_user_agent,
        )
    return _context


async def render_html_to_pdf(
    html: str,
    *,
    timeout_ms: int = PAGE_TIMEOUT_MS,
) -> bytes:
    """Render an HTML string to PDF bytes.

    Prefer :func:`render_url_to_pdf` when a URL is available — it lets
    Chromium load images and stylesheets from the original domain.

    Args:
        html: Cleaned HTML content of the filing.
        timeout_ms: Maximum wait time for page load in milliseconds.

    Returns:
        PDF content as bytes.
    """
    context = await _get_context()
    page = await context.new_page()
    try:
        # Emulate print media for proper styling.
        await page.emulate_media(media="print")

        # set_content with wait_until="networkidle" hangs on huge SEC filings
        # because residual font/stylesheet/keep-alive requests can prevent the
        # network from ever going quiet for the required 500ms. "load" fires
        # after the document and its initial subresources are loaded, which
        # is what we actually want — networkidle was overkill given the HTML
        # has already had its images base64-inlined by preprocess_filing.
        await page.set_content(html, wait_until="load", timeout=timeout_ms)

        # Generate the PDF. Explicit timeout because rasterizing a 500-page
        # S-1 can legitimately take several minutes.
        pdf_bytes: bytes = await page.pdf(**PDF_OPTIONS, timeout=PDF_TIMEOUT_MS)
        logger.info("PDF rendered successfully (%d bytes)", len(pdf_bytes))
        return pdf_bytes

    finally:
        await page.close()


async def render_url_to_pdf(
    url: str,
    *,
    strip_xbrl: bool = True,
    timeout_ms: int = PAGE_TIMEOUT_MS,
) -> bytes:
    """Navigate to a URL, optionally strip XBRL, and render to PDF.

    This is the preferred rendering path because Chromium loads all
    external resources (images, CSS) directly from the origin domain,
    avoiding broken-image issues that occur with ``set_content()``.

    After the page reaches ``networkidle``, XBRL ``ix:`` tags are
    removed via in-page JavaScript so they don't pollute the PDF.

    Args:
        url: URL to navigate to.
        strip_xbrl: If ``True`` (default), strip ``ix:`` XBRL tags
            from the live DOM before rendering.
        timeout_ms: Maximum wait time for page load in milliseconds.

    Returns:
        PDF content as bytes.
    """
    context = await _get_context()
    page = await context.new_page()
    try:
        await page.emulate_media(media="print")

        logger.info("Navigating to %s", url)
        # Use "load" instead of "networkidle" — see render_html_to_pdf for
        # the rationale. networkidle stalls on huge SEC filings.
        await page.goto(url, wait_until="load", timeout=timeout_ms)

        if strip_xbrl:
            logger.debug("Stripping XBRL tags via JavaScript")
            await page.evaluate(STRIP_XBRL_JS)

        # Explicit timeout for the rasterization step (big S-1s take minutes).
        pdf_bytes: bytes = await page.pdf(**PDF_OPTIONS, timeout=PDF_TIMEOUT_MS)
        logger.info("PDF rendered from URL %s (%d bytes)", url, len(pdf_bytes))
        return pdf_bytes

    finally:
        await page.close()


async def close_browser() -> None:
    """Shut down the singleton browser cleanly."""
    global _browser, _playwright_instance, _context
    if _context is not None:
        try:
            await _context.close()
        except Exception:
            pass
        _context = None
    if _browser is not None:
        await _browser.close()
        _browser = None
    if _playwright_instance is not None:
        await _playwright_instance.stop()
        _playwright_instance = None
        logger.info("Closed headless Chromium browser")
