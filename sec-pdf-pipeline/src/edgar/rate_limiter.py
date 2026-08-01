"""Token-bucket rate limiter for SEC EDGAR requests.

SEC enforces a limit of 10 requests per second.  Exceeding this may
result in temporary or permanent IP bans.  Every outbound request to
SEC endpoints MUST be issued through :func:`get_sec_client` so the
limiter and required User-Agent header are always applied.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from typing import Any

import httpx

from src.config import get_settings

logger = logging.getLogger(__name__)

# SEC allows a maximum of 10 requests per second.
MAX_REQUESTS_PER_SECOND: int = 10

# Every URL this module fetches must be an HTTPS URL on one of these hosts.
#
# sec_get is documented as the only way the pipeline talks to SEC, but it used
# to fetch whatever URL it was handed. Two of its three call sites take the URL
# from filing content rather than from us: the <img src> attributes inside a
# filing's HTML, and the document links scraped off an EDGAR index page. A
# filing containing <img src="http://169.254.169.254/latest/meta-data/..."> had
# its response base64-embedded into the rendered PDF, which makes the result
# readable — a full SSRF with read-back, from a document anyone can file.
SEC_HOST_SUFFIX = ".sec.gov"
SEC_APEX_HOST = "sec.gov"

# Redirects are followed manually so each hop is re-checked. A 302 to an
# internal address is the standard way around a check applied only to the URL
# the caller passed in.
MAX_REDIRECTS: int = 5

# Hard ceiling on a single response body. Filings are large (an S-1 with
# inline exhibits runs to tens of MB) but not unbounded, and the body is held
# in memory. Callers that know they want something small pass a lower cap.
MAX_RESPONSE_BYTES: int = 64 * 1024 * 1024


class DisallowedURLError(ValueError):
    """Raised when a URL is not an HTTPS URL on an SEC host."""


class ResponseTooLargeError(ValueError):
    """Raised when a response body exceeds the caller's byte cap."""


def _is_public_address(host: str) -> bool:
    """True unless the host resolves to a private, loopback or link-local IP.

    The host allowlist above is the real control here; this is the backstop for
    the case where an SEC name resolves somewhere it shouldn't (a poisoned
    resolver, an /etc/hosts entry, a literal IP that slipped through). It fails
    OPEN on resolution errors on purpose — this environment can't always reach
    DNS, and turning a lookup failure into a hard block would take the pipeline
    down for a reason that has nothing to do with the request being unsafe.
    The connection just fails a moment later anyway.
    """
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return True
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_multicast
            or addr.is_unspecified
        ):
            logger.warning("Refusing %s: resolves to non-public address %s", host, addr)
            return False
    return True


def validate_sec_url(url: str | httpx.URL) -> httpx.URL:
    """Return *url* as an :class:`httpx.URL`, or raise if it isn't SEC over HTTPS.

    Raises:
        DisallowedURLError: if the scheme isn't https or the host isn't SEC.
    """
    try:
        parsed = httpx.URL(str(url))
    except Exception as exc:  # malformed URL
        raise DisallowedURLError(f"Malformed URL: {url!r}") from exc
    if parsed.scheme != "https":
        raise DisallowedURLError(
            f"Refusing non-HTTPS URL: {url!r} (only https to SEC is allowed)"
        )
    host = (parsed.host or "").lower().rstrip(".")
    if not host or (host != SEC_APEX_HOST and not host.endswith(SEC_HOST_SUFFIX)):
        raise DisallowedURLError(f"Refusing non-SEC host: {host or url!r}")
    if not _is_public_address(host):
        raise DisallowedURLError(f"Refusing {host}: resolves to a non-public address")
    return parsed


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


async def acquire_sec_token() -> None:
    """Acquire one SEC token from the shared bucket without issuing a request.

    Used by callers that don't go through :func:`sec_get` but still need to
    respect SEC's 10 req/s rule — specifically the Playwright route handler
    that gates browser-issued subresource loads during S-1 renders.
    """
    await _get_limiter().acquire()


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
            # Redirects are followed by sec_get instead, so every hop goes
            # through validate_sec_url. Letting httpx follow them silently
            # meant a 302 off SEC was fetched without any check at all.
            follow_redirects=False,
        )
    return _client


async def _send_capped(
    client: httpx.AsyncClient,
    request: httpx.Request,
    max_bytes: int,
) -> httpx.Response:
    """Send *request* and read at most *max_bytes* of the body.

    The body used to be read with no limit at all, so a single response could
    take the process down by itself. Read as a stream and stop at the cap.
    """
    response = await client.send(request, stream=True)
    try:
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > max_bytes:
            raise ResponseTooLargeError(
                f"{request.url} declared {declared} bytes (cap {max_bytes})"
            )
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise ResponseTooLargeError(
                    f"{request.url} exceeded {max_bytes} bytes"
                )
            chunks.append(chunk)
        body = b"".join(chunks)
    finally:
        await response.aclose()

    # aiter_bytes yields decoded bytes, so the transfer headers no longer
    # describe the content we are attaching.
    headers = httpx.Headers(
        [
            (k, v)
            for k, v in response.headers.multi_items()
            if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")
        ]
    )
    return httpx.Response(
        status_code=response.status_code,
        headers=headers,
        content=body,
        request=request,
        extensions=response.extensions,
    )


async def sec_get(
    url: str,
    *,
    max_bytes: int = MAX_RESPONSE_BYTES,
    **kwargs: Any,
) -> httpx.Response:
    """Perform a rate-limited GET request to an SEC endpoint.

    This is the **only** function that should be used to contact SEC
    servers.  It enforces the 10 req/s token-bucket limit, attaches the
    required ``User-Agent`` header, and refuses any URL that is not HTTPS on
    an SEC host — including after a redirect.

    Args:
        url: Full URL to fetch. Must be https on sec.gov or a subdomain.
        max_bytes: Cap on the response body size.
        **kwargs: Extra keyword arguments forwarded to the request builder.

    Returns:
        The HTTP response, fully read.

    Raises:
        DisallowedURLError: If the URL (or a redirect target) isn't SEC/HTTPS.
        ResponseTooLargeError: If the body exceeds *max_bytes*.
        httpx.HTTPStatusError: On 4xx/5xx responses.
    """
    limiter = _get_limiter()
    client = await get_sec_client()

    target = validate_sec_url(url)
    for _ in range(MAX_REDIRECTS + 1):
        await limiter.acquire()
        logger.debug("SEC GET %s", target)
        request = client.build_request("GET", target, **kwargs)
        response = await _send_capped(client, request, max_bytes)
        if response.is_redirect:
            location = response.headers.get("location")
            if not location:
                break
            # Each hop is re-validated, so a redirect can't walk off SEC.
            target = validate_sec_url(response.url.join(location))
            continue
        response.raise_for_status()
        return response

    raise DisallowedURLError(f"Too many redirects starting from {url!r}")


async def close_client() -> None:
    """Gracefully close the shared HTTP client."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
