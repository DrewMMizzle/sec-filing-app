#!/usr/bin/env python3
"""Polling scheduler — runs the EDGAR poller on a configurable interval.

By default polls every 15 minutes, iterating through all CIKs in the
watchlist.  Designed to be the main entrypoint of the ``app`` Docker
service.

Usage:
    python -m scheduler.cron
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from src.config import configure_logging, get_settings
from src.edgar.poller import poll_all
from src.edgar.rate_limiter import close_client
from src.storage.db import init_db

logger = logging.getLogger(__name__)

_shutdown = asyncio.Event()


def _handle_signal(sig: signal.Signals) -> None:
    logger.info("Received %s — shutting down gracefully", sig.name)
    _shutdown.set()


async def run_scheduler() -> None:
    """Run the polling loop until interrupted."""
    configure_logging()
    settings = get_settings()
    interval = settings.poll_interval_minutes * 60

    await init_db()
    logger.info(
        "Starting scheduler — polling every %d minute(s)",
        settings.poll_interval_minutes,
    )

    # Register signal handlers for graceful shutdown.
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda s=sig: _handle_signal(s))

    while not _shutdown.is_set():
        try:
            new_count = await poll_all()
            logger.info(
                "Poll cycle complete — %d new filing(s). "
                "Next poll in %d minute(s).",
                new_count,
                settings.poll_interval_minutes,
            )
        except Exception:
            logger.exception("Error during poll cycle")

        # Wait for the interval or until shutdown is signalled.
        try:
            await asyncio.wait_for(_shutdown.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass  # Timeout means it's time for the next cycle.

    # Cleanup.
    await close_client()
    logger.info("Scheduler stopped")


def main() -> None:
    """Entry point."""
    try:
        asyncio.run(run_scheduler())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
