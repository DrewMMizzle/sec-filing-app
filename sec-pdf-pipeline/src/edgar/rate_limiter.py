"""Token-bucket rate limiter for SEC EDGAR requests.

SEC enforces a limit of 10 requests per second.  Exceeding this may
result in temporary or permanent IP bans.  Every outbound request to
SEC endpoints MUST be issued through :func:`get_sec_client` so the
limiter and required User-Agent header are always applied.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from src.config import get_settings

logger = logging.getLogger(__name__)

# SEC allows a maximum of 10 requests per second.
MAX_REQUESTS_PER_SECOND: int = 10


class TokenBucketLimiter:
    """Async token-bucket rate limiter.

    Tokens refill at *rate* tokens per second up to a maximum of *capacity*.
    Calling :meth:`acquire` blocks until a token is available.
    """

    def __init__(self, rate: float = MAX_REQUESTS_PER_SECOND, capacity: int | None = None) -> None:
        self.rate = rate
        self.capacity = capacity or int(rate)
        self._tokens: float = float(self.capacity)
        self._last_refill: float = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        """Wait until a token is available, then consume one."""
        async with self._lock:
            while True:
                now = time.monotonic()
                elapsed = now - self._last_refill
                self._tokens = min(self.capacity, self._tokens + elapsed * self.rate)
                self._last_refill = now

                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return

                # Sleep just long enough for one token to appear.
                wait = (1.0 - self._tokens) / self.rate
                await asyncio.sleep(wait)


# Module-level singleton — shared across the entire process.
_limiter: TokenBucketLimiter | None = None
_client: httpx.AsyncClient | None = None


def _get_limiter() -> TokenBucketLimiter:
    global _limiter
    if _limiter is None:
        _limiter = TokenBucketLimiter()
    return _limiter


async def get_sec_client() -> httpx.AsyncClient:
    """Return a shared :class:`httpx.AsyncClient` configured for SEC EDGAR.

    The client automatically includes the SEC-required ``User-Agent`` header.
    """
    global _client
    if _client is None:
        settings = get_settings()
        _client = httpx.AsyncClient(
            headers={"User-Agent": settings.sec_user_agent},
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )
    return _client


async def sec_get(url: str, **kwargs: Any) -> httpx.Response:
    """Perform a rate-limited GET request to an SEC endpoint.

    This is the **only** function that should be used to contact SEC
    servers.  It enforces the 10 req/s token-bucket limit and attaches
    the required ``User-Agent`` header.

    Args:
        url: Full URL to fetch.
        **kwargs: Extra keyword arguments forwarded to ``httpx.AsyncClient.get``.

    Returns:
        The HTTP response.

    Raises:
        httpx.HTTPStatusError: On 4xx/5xx responses.
    """
    limiter = _get_limiter()
    client = await get_sec_client()

    await limiter.acquire()
    logger.debug("SEC GET %s", url)
    response = await client.get(url, **kwargs)
    response.raise_for_status()
    return response


async def close_client() -> None:
    """Gracefully close the shared HTTP client."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
