import fs from "fs";
import { PDFParse } from "pdf-parse";

// Strip whitespace / quote variants so we can match a quote pulled from chat
// prose against the PDF's text-extraction output (which renders different
// quote glyphs and may break lines mid-sentence).
function normalize(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// Try the full quote first, then the first ~140 normalized chars, then the
// first ~60 — long quotes often span PDF lines and never substring-match
// cleanly. The shorter forms are good enough to locate the right page.
function candidates(quote: string): string[] {
  const full = normalize(quote);
  const out: string[] = [];
  if (full.length >= 8) out.push(full);
  if (full.length > 140) out.push(full.slice(0, 140));
  if (full.length > 60) out.push(full.slice(0, 60));
  return out;
}

// Return the 1-indexed page number containing the quote, or null if not found.
export async function findPageForQuote(absPath: string, quote: string): Promise<number | null> {
  if (!quote || !quote.trim()) return null;
  const buffer = fs.readFileSync(absPath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const pages = result.pages ?? [];
    if (pages.length === 0) return null;
    const queries = candidates(quote);
    for (const q of queries) {
      for (const p of pages) {
        if (normalize(p.text).includes(q)) return p.num;
      }
    }
    return null;
  } finally {
    await parser.destroy();
  }
}
