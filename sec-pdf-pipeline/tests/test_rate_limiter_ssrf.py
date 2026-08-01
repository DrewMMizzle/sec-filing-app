"""URL and response controls on the only path the pipeline uses to reach SEC.

sec_get is documented as the single way this pipeline talks to SEC, but it
used to fetch whatever URL it was handed. Two of its three call sites take the
URL from filing content: the ``<img src>`` attributes inside a filing's HTML,
and the document links scraped off an EDGAR index page. Anyone can file with
SEC, so both are attacker-controlled.
"""

from __future__ import annotations

import httpx
import pytest

from src.edgar import rate_limiter
from src.edgar.rate_limiter import (
    DisallowedURLError,
    ResponseTooLargeError,
    sec_get,
    validate_sec_url,
)


@pytest.fixture(autouse=True)
def _reset_client():
    """Each test installs its own transport, so drop the shared client."""
    rate_limiter._client = None
    yield
    rate_limiter._client = None


def _install(handler, **client_kwargs):
    """Point the shared client at a mock transport."""
    rate_limiter._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
        **client_kwargs,
    )


# ── URL allowlist ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/a.htm",
        "https://data.sec.gov/submissions/CIK0000320193.json",
        "https://efts.sec.gov/LATEST/search-index?q=x",
        "https://sec.gov/",
        "https://WWW.SEC.GOV/Archives/a.htm",
    ],
)
def test_real_sec_urls_are_allowed(url):
    assert validate_sec_url(url).host


@pytest.mark.parametrize(
    "url,why",
    [
        ("http://www.sec.gov/a.htm", "plain HTTP, downgradeable"),
        ("https://169.254.169.254/latest/meta-data/", "cloud metadata by IP"),
        ("http://169.254.169.254/latest/meta-data/iam/", "the classic SSRF target"),
        ("https://localhost:8080/admin", "loopback by name"),
        ("https://127.0.0.1/", "loopback by IP"),
        ("https://10.0.0.5/internal", "RFC1918"),
        ("https://[::1]/", "IPv6 loopback"),
        ("https://evil.com/x", "off-allowlist entirely"),
        ("https://sec.gov.evil.com/x", "suffix confusion"),
        ("https://notsec.gov/x", "substring confusion"),
        ("https://user:pw@evil.com/x", "credentials hiding the real host"),
        ("file:///etc/passwd", "local file"),
        ("gopher://sec.gov/x", "non-HTTP scheme"),
        ("https://evil.com/?x=https://www.sec.gov/", "allowed host only in the query"),
        ("https://evil.com/#https://www.sec.gov/", "allowed host only in the fragment"),
        ("", "empty"),
    ],
)
def test_disallowed_urls_are_refused(url, why):
    with pytest.raises(DisallowedURLError):
        validate_sec_url(url)
    assert why  # documents the case in the failure output


def test_fully_qualified_sec_host_still_works():
    # "www.sec.gov." is the same name written absolutely — allowed, and the
    # trailing dot must not be a way to slip past the suffix check either.
    assert validate_sec_url("https://www.sec.gov./a.htm").host


# ── redirects ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_redirect_off_sec_is_refused():
    """The standard way around a check applied only to the first URL."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.host == "www.sec.gov":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/"})
        return httpx.Response(200, content=b"SECRET")

    _install(handler)
    with pytest.raises(DisallowedURLError):
        await sec_get("https://www.sec.gov/Archives/a.htm")
    assert seen == ["https://www.sec.gov/Archives/a.htm"], "must not have issued the second hop"


@pytest.mark.asyncio
async def test_redirect_within_sec_is_followed():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/old":
            return httpx.Response(301, headers={"location": "https://www.sec.gov/new"})
        return httpx.Response(200, content=b"<html>ok</html>")

    _install(handler)
    resp = await sec_get("https://www.sec.gov/old")
    assert resp.status_code == 200
    assert resp.content == b"<html>ok</html>"


@pytest.mark.asyncio
async def test_relative_redirect_is_resolved_and_followed():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": "/b"})
        return httpx.Response(200, content=b"b")

    _install(handler)
    assert (await sec_get("https://www.sec.gov/a")).content == b"b"


@pytest.mark.asyncio
async def test_redirect_loop_terminates():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://www.sec.gov/loop"})

    _install(handler)
    with pytest.raises(DisallowedURLError, match="Too many redirects"):
        await sec_get("https://www.sec.gov/loop")


# ── response size ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_body_over_the_cap_is_refused():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 5000)

    _install(handler)
    with pytest.raises(ResponseTooLargeError):
        await sec_get("https://www.sec.gov/big", max_bytes=1000)


@pytest.mark.asyncio
async def test_declared_content_length_over_the_cap_is_refused_early():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 10, headers={"content-length": "999999999"})

    _install(handler)
    with pytest.raises(ResponseTooLargeError):
        await sec_get("https://www.sec.gov/lying", max_bytes=1000)


@pytest.mark.asyncio
async def test_body_under_the_cap_is_returned_intact():
    body = b"y" * 999

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    _install(handler)
    resp = await sec_get("https://www.sec.gov/ok", max_bytes=1000)
    assert resp.content == body


@pytest.mark.asyncio
async def test_text_and_json_still_work_after_streaming():
    """sec_get rebuilds the response, so the usual accessors must survive."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"cik": "0000320193"}, headers={"content-type": "application/json"}
        )

    _install(handler)
    resp = await sec_get("https://data.sec.gov/submissions/CIK0000320193.json")
    assert resp.json() == {"cik": "0000320193"}
    assert "0000320193" in resp.text


@pytest.mark.asyncio
async def test_http_errors_still_raise():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    _install(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await sec_get("https://www.sec.gov/missing")


@pytest.mark.asyncio
async def test_off_sec_url_never_reaches_the_network():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=b"SECRET")

    _install(handler)
    with pytest.raises(DisallowedURLError):
        await sec_get("http://169.254.169.254/latest/meta-data/")
    assert calls == []
