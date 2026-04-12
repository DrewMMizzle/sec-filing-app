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

# Maximum time to wait for the page to load and reach networkidle.
PAGE_TIMEOUT_MS = 120_000  # 2 minutes — some filings are very large.

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


async def _get_browser() -> Browser:
    """Launch or return the singleton headless Chromium browser."""
    global _browser, _playwright_instance
    if _browser is None or not _browser.is_connected():
        _playwright_instance = await async_playwright().start()
        _browser = await _playwright_instance.chromium.launch(headless=True)
        logger.info("Launched headless Chromium browser")
    return _browser


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
    settings = get_settings()
    browser = await _get_browser()
    context: BrowserContext = await browser.new_context(
        java_script_enabled=True,
        bypass_csp=True,
        user_agent=settings.sec_user_agent,
    )

    try:
        page = await context.new_page()

        # Emulate print media for proper styling.
        await page.emulate_media(media="print")

        # Load the HTML content.
        await page.set_content(html, wait_until="networkidle", timeout=timeout_ms)

        # Generate the PDF.
        pdf_bytes: bytes = await page.pdf(**PDF_OPTIONS)
        logger.info("PDF rendered successfully (%d bytes)", len(pdf_bytes))
        return pdf_bytes

    finally:
        await context.close()


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
    settings = get_settings()
    browser = await _get_browser()
    context: BrowserContext = await browser.new_context(
        java_script_enabled=True,
        bypass_csp=True,
        user_agent=settings.sec_user_agent,
    )

    try:
        page = await context.new_page()
        await page.emulate_media(media="print")

        logger.info("Navigating to %s", url)
        await page.goto(url, wait_until="networkidle", timeout=timeout_ms)

        if strip_xbrl:
            logger.debug("Stripping XBRL tags via JavaScript")
            await page.evaluate(STRIP_XBRL_JS)

        pdf_bytes: bytes = await page.pdf(**PDF_OPTIONS)
        logger.info("PDF rendered from URL %s (%d bytes)", url, len(pdf_bytes))
        return pdf_bytes

    finally:
        await context.close()


async def close_browser() -> None:
    """Shut down the singleton browser cleanly."""
    global _browser, _playwright_instance
    if _browser is not None:
        await _browser.close()
        _browser = None
    if _playwright_instance is not None:
        await _playwright_instance.stop()
        _playwright_instance = None
        logger.info("Closed headless Chromium browser")
