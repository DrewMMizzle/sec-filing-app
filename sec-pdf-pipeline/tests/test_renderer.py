"""Tests for the renderer preprocessing and PDF generation modules."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.renderer.preprocess import (
    strip_xbrl_tags,
    rewrite_relative_urls,
    fix_image_references,
    preprocess_filing,
)


class TestStripXbrlTags:
    """Tests for XBRL tag stripping."""

    def test_strips_ix_nonfraction(self):
        html = '<p><ix:nonFraction name="us-gaap:Revenue">1000000</ix:nonFraction></p>'
        result = strip_xbrl_tags(html)
        assert "ix:nonFraction" not in result
        assert "1000000" in result

    def test_strips_ix_nonnumeric(self):
        html = '<span><ix:nonNumeric name="dei:EntityName">Apple Inc.</ix:nonNumeric></span>'
        result = strip_xbrl_tags(html)
        assert "ix:nonNumeric" not in result
        assert "Apple Inc." in result

    def test_preserves_non_ix_content(self):
        html = "<div><p>Regular content</p></div>"
        result = strip_xbrl_tags(html)
        assert "Regular content" in result

    def test_handles_nested_ix_tags(self):
        html = (
            '<ix:nonNumeric>'
            '<ix:nonFraction>42</ix:nonFraction>'
            ' million'
            '</ix:nonNumeric>'
        )
        result = strip_xbrl_tags(html)
        assert "ix:" not in result
        assert "42" in result
        assert "million" in result

    def test_handles_empty_html(self):
        result = strip_xbrl_tags("")
        assert isinstance(result, str)

    def test_strips_xmlns_declarations(self):
        html = '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><body>Hi</body></html>'
        result = strip_xbrl_tags(html)
        assert "xmlns:ix" not in result
        assert "Hi" in result


class TestRewriteRelativeUrls:
    """Tests for URL rewriting."""

    def test_rewrites_relative_href(self):
        html = '<a href="filing.htm">Link</a>'
        base = "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/"
        result = rewrite_relative_urls(html, base)
        assert 'href="https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/filing.htm"' in result

    def test_rewrites_relative_src(self):
        html = '<img src="chart.png"/>'
        base = "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/"
        result = rewrite_relative_urls(html, base)
        assert "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/chart.png" in result

    def test_leaves_absolute_urls_alone(self):
        html = '<a href="https://example.com/page">Link</a>'
        result = rewrite_relative_urls(html, "https://www.sec.gov/base/")
        assert 'href="https://example.com/page"' in result

    def test_leaves_data_urls_alone(self):
        html = '<img src="data:image/png;base64,abc123"/>'
        result = rewrite_relative_urls(html, "https://www.sec.gov/base/")
        assert "data:image/png;base64,abc123" in result

    def test_leaves_mailto_alone(self):
        html = '<a href="mailto:test@example.com">Email</a>'
        result = rewrite_relative_urls(html, "https://www.sec.gov/base/")
        assert "mailto:test@example.com" in result

    def test_leaves_anchor_links_alone(self):
        html = '<a href="#section1">Jump</a>'
        result = rewrite_relative_urls(html, "https://www.sec.gov/base/")
        assert 'href="#section1"' in result


class TestFixImageReferences:
    """Tests for image reference fixing."""

    def test_resolves_relative_images(self):
        html = '<img src="images/logo.png"/>'
        base = "https://www.sec.gov/Archives/edgar/data/1/2/"
        result = fix_image_references(html, base)
        assert "https://www.sec.gov/Archives/edgar/data/1/2/images/logo.png" in result

    def test_leaves_absolute_images(self):
        html = '<img src="https://cdn.example.com/logo.png"/>'
        result = fix_image_references(html, "https://www.sec.gov/base/")
        assert "https://cdn.example.com/logo.png" in result

    def test_leaves_data_uri_images(self):
        html = '<img src="data:image/gif;base64,R0lGODlh"/>'
        result = fix_image_references(html, "https://www.sec.gov/base/")
        assert "data:image/gif;base64,R0lGODlh" in result


@pytest.mark.asyncio
async def test_preprocess_filing_integration():
    """Test the full preprocessing pipeline with mocked HTTP."""
    raw_html = """
    <html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">
    <body>
        <p><ix:nonFraction>42</ix:nonFraction> million</p>
        <a href="exhibit.htm">Exhibit</a>
        <img src="chart.png"/>
    </body>
    </html>
    """
    mock_response = MagicMock()
    mock_response.text = raw_html

    url = "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/aapl.htm"

    with patch("src.renderer.preprocess.sec_get", new_callable=AsyncMock, return_value=mock_response):
        result = await preprocess_filing(url)

    # XBRL tags should be stripped.
    assert "ix:" not in result
    assert "42" in result
    # Relative URLs should be absolute.
    assert "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/exhibit.htm" in result
    assert "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/chart.png" in result
