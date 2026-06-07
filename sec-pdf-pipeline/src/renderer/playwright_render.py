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

# Hard wall-clock cap on the whole render. Sits outside the per-step
# timeouts to catch wedges in the unbounded Playwright calls
# (new_page / route / emulate_media / close): if Chromium hangs there,
# the per-step timeouts inside set_content / page.pdf never get a chance
# to fire and the worker silently sits until Railway kills the container.
# The outer wait_for converts that into a regular exception the retry
# loop can record.
RENDER_WALL_CLOCK_TIMEOUT_S = 12 * 60  # 12 minutes.

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
    loads it via ``set_content`` and is locked down so it makes no
    outbound network requests during rendering — every external
    resource the SEC filing references is either already inlined or
    deliberately aborted at the route layer.

    The whole render is bounded by ``RENDER_WALL_CLOCK_TIMEOUT_S`` so a
    wedged Chromium can't hang the worker indefinitely; if the budget
    expires the cached browser is torn down so the next retry starts
    with a fresh Chromium instance.

    Args:
        html: Cleaned, image-inlined HTML content of the filing.
        timeout_ms: Maximum wait time for the set_content step.

    Returns:
        PDF content as bytes.
    """
    try:
        return await asyncio.wait_for(
            _render_html_to_pdf_inner(html, timeout_ms=timeout_ms),
            timeout=RENDER_WALL_CLOCK_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        # Chromium is wedged somewhere we can't bound from inside —
        # drop the singleton so the next attempt rebuilds it.
        try:
            await close_browser()
        except Exception:
            pass
        raise RuntimeError(
            f"render_html_to_pdf exceeded the {RENDER_WALL_CLOCK_TIMEOUT_S}s wall-clock budget."
        ) from None


async def _render_html_to_pdf_inner(
    html: str,
    *,
    timeout_ms: int,
) -> bytes:
    context = await _get_context()
    page = await context.new_page()
    try:
        # Block every outbound request except data: URIs. The preprocess
        # step has already inlined images as base64; anything else the
        # filing still references — external stylesheets, fonts, scripts —
        # would otherwise be fetched by Chromium from sec.gov and trigger
        # SEC's anti-bot block (same block the URL-render path hit), which
        # causes the load event to never fire and set_content to time out.
        async def _abort_external(route, request):
            try:
                if request.url.startswith("data:"):
                    await route.continue_()
                else:
                    await route.abort()
            except Exception:
                # Page may have closed mid-route — swallow so we don't
                # propagate routing errors out of an unrelated request.
                pass

        await page.route("**/*", _abort_external)
        await page.emulate_media(media="print")

        # wait_until="domcontentloaded" fires once the HTML is fully
        # parsed. That's the right primitive for preprocessed HTML: we
        # have no external resources to wait on (they're either inlined
        # or aborted above). "load" used to be the default here, but it
        # waits for every subresource — including the SEC stylesheet /
        # font / script references we've now aborted, which means it
        # would never fire and we'd hit the page timeout.
        await page.set_content(html, wait_until="domcontentloaded", timeout=timeout_ms)

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
