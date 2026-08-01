"""Image embedding is the read-back half of the SSRF.

``embed_images_as_base64`` fetches every ``<img src>`` in the filing and puts
the response body into the rendered PDF as a data URI. The filing is written by
whoever filed it, so an ``<img>`` pointing at an internal address turned the
PDF into a readable copy of that response.
"""

from __future__ import annotations

import base64

import httpx
import pytest

from src.edgar import rate_limiter
from src.renderer.preprocess import MAX_IMAGE_BYTES, embed_images_as_base64

BASE = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000050/"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture(autouse=True)
def _reset_client():
    rate_limiter._client = None
    yield
    rate_limiter._client = None


def _install(handler):
    rate_limiter._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )


@pytest.mark.asyncio
async def test_internal_image_source_is_never_fetched():
    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fetched.append(str(request.url))
        return httpx.Response(200, content=b"ami-secret-role-credentials")

    _install(handler)
    html = '<img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/">'
    out = await embed_images_as_base64(html, BASE)

    assert fetched == [], "the metadata endpoint must not be contacted"
    assert "169.254.169.254" not in base64.b64encode(b"ami-secret").decode()
    assert "data:" not in out, "nothing should have been embedded"


@pytest.mark.asyncio
async def test_protocol_relative_source_off_sec_is_refused():
    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fetched.append(str(request.url))
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    _install(handler)
    # "//evil.com/x.png" inherits the base scheme and lands off SEC.
    out = await embed_images_as_base64('<img src="//evil.com/x.png">', BASE)
    assert fetched == []
    assert "data:" not in out


@pytest.mark.asyncio
async def test_a_real_sec_image_is_still_embedded():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "www.sec.gov"
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    _install(handler)
    out = await embed_images_as_base64('<img src="chart.jpg">', BASE)
    assert f"data:image/png;base64,{base64.b64encode(PNG).decode()}" in out


@pytest.mark.asyncio
async def test_non_image_content_type_is_not_embedded():
    """An SEC URL that returns JSON is still not an image."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b'{"secret": 1}', headers={"content-type": "application/json"}
        )

    _install(handler)
    out = await embed_images_as_base64('<img src="notanimage.json">', BASE)
    assert "data:" not in out
    assert "secret" not in out


@pytest.mark.asyncio
async def test_html_content_type_is_not_embedded():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<html>internal page</html>", headers={"content-type": "text/html"}
        )

    _install(handler)
    out = await embed_images_as_base64('<img src="page.htm">', BASE)
    assert "data:" not in out


@pytest.mark.asyncio
async def test_oversized_image_is_skipped_not_embedded():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"\x89PNG" + b"z" * (MAX_IMAGE_BYTES + 1),
            headers={"content-type": "image/png"},
        )

    _install(handler)
    out = await embed_images_as_base64('<img src="huge.png">', BASE)
    assert "data:" not in out


@pytest.mark.asyncio
async def test_one_bad_image_does_not_stop_the_good_ones():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("good.png"):
            return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})
        return httpx.Response(404)

    _install(handler)
    html = '<img src="http://127.0.0.1/x.png"><img src="missing.png"><img src="good.png">'
    out = await embed_images_as_base64(html, BASE)
    assert out.count("data:image/png;base64,") == 1


@pytest.mark.asyncio
async def test_existing_data_uris_are_left_alone():
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not fetch a data: URI")

    _install(handler)
    html = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
    out = await embed_images_as_base64(html, BASE)
    assert "R0lGODlhAQABAAAAACw=" in out
