"""Render SEC filing pages to PDF using Playwright headless Chromium.

The pipeline preprocesses filings in Python (fetching the HTML via the
rate-limited httpx client and inlining images as base64) and pushes the
cleaned HTML into Chromium via :func:`render_html_to_pdf`. Chromium
itself never talks to SEC — that's intentional, since SEC's anti-bot
detection blocks browser fingerprints even when the User-Agent string
is correct. Letting httpx do the SEC fetches with the documented UA is
what 1700+ historical renders rely on; this module is just the
rasterizer.
"""

from __future__ import annotations

import asyncio
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

# Page load budget. Bumped from 2 min because S-1 / S-1/A filings — and
# the occasional unusually large 10-K — can take longer than 2 minutes to
# settle. Combined with wait_until="load" (instead of the previous
# "networkidle"), this avoids the historical wedge where Chromium stayed
# parked waiting for background keep-alives to drain.
PAGE_TIMEOUT_MS = 5 * 60 * 1000  # 5 minutes for the set_content/load step.

# Cap on the page.pdf() rasterization step itself. A 500-page S-1 with
# dense tables can legitimately take a few minutes to paginate; Playwright
# Python's default page timeout (30s) is way too short for that.
PDF_TIMEOUT_MS = 5 * 60 * 1000  # 5 minutes.

# JavaScript to strip ix: XBRL tags in the live DOM while preserving
# their child content. Runs after the page has fully loaded so all
# images and styles are already resolved.
STRIP_XBRL_JS = """
() => {
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
    for (const el of toRemove) {
        el.remove();
    }
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
        logger.info("Creating browser context with User-Agent: %s", settings.sec_user_agent)
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

    The HTML is expected to already be preprocessed (XBRL stripped,
    URLs absolutized, images inlined as base64 data URIs). Chromium
    loads it via ``set_content`` and never makes outbound network
    requests during rendering — every external resource a SEC filing
    references is already inlined by the time we get here.

    Args:
        html: Cleaned, image-inlined HTML content of the filing.
        timeout_ms: Maximum wait time for the set_content step.

    Returns:
        PDF content as bytes.
    """
    context = await _get_context()
    page = await context.new_page()
    try:
        await page.emulate_media(media="print")

        # wait_until="load" fires once the document and its initial
        # subresources finish — that's what we actually want. The previous
        # "networkidle" required 500ms of zero network activity which
        # bigger filings, especially image-heavy S-1s, never reliably
        # reach because of trailing keep-alives and font requests.
        await page.set_content(html, wait_until="load", timeout=timeout_ms)

        # Bound page.pdf() externally with asyncio.wait_for since this
        # Playwright Python build doesn't accept a `timeout` keyword on
        # page.pdf(). A wedged Chromium still can't hang the render
        # indefinitely this way.
        try:
            pdf_bytes: bytes = await asyncio.wait_for(
                page.pdf(**PDF_OPTIONS),
                timeout=PDF_TIMEOUT_MS / 1000,
            )
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"page.pdf() exceeded the {PDF_TIMEOUT_MS // 1000}s budget."
            ) from None

        logger.info("PDF rendered successfully (%d bytes)", len(pdf_bytes))
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
