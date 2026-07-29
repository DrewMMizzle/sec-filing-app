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

type PageText = { num: number; text: string };

// Extracting text from a rendered filing is expensive — a 500-page S-1 takes
// seconds and, when read synchronously, pins the event loop for every other
// request. Citation deep-links hit the SAME document repeatedly (once per
// quote the reader clicks), so the extraction is cached and the pages are
// normalized once at extraction time instead of on every lookup.
//
// Entries hold whole documents' text, so the cache is deliberately small.
// Keyed on path + mtime + size, so a re-render invalidates the old entry
// rather than serving page numbers from stale text.
const MAX_CACHED_DOCS = 4;

// Stores the in-flight promise, not the resolved value, so two concurrent
// citation clicks on the same uncached PDF share one extraction instead of
// both paying for it.
const cache = new Map<string, Promise<PageText[]>>();

async function extractPages(absPath: string): Promise<PageText[]> {
  const buffer = await fs.promises.readFile(absPath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result.pages ?? []).map((p) => ({ num: p.num, text: normalize(p.text) }));
  } finally {
    await parser.destroy();
  }
}

async function getNormalizedPages(absPath: string): Promise<PageText[]> {
  const stat = await fs.promises.stat(absPath);
  const key = `${absPath}:${stat.mtimeMs}:${stat.size}`;

  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position so a hot document isn't evicted by a one-off.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const pending = extractPages(absPath);
  cache.set(key, pending);
  // A failed extraction must not be cached, or every later lookup for this
  // file replays the same rejection.
  pending.catch(() => cache.delete(key));

  for (const oldest of Array.from(cache.keys())) {
    if (cache.size <= MAX_CACHED_DOCS) break;
    cache.delete(oldest);
  }

  return pending;
}

// Return the 1-indexed page number containing the quote, or null if not found.
export async function findPageForQuote(absPath: string, quote: string): Promise<number | null> {
  if (!quote || !quote.trim()) return null;
  const queries = candidates(quote);
  if (queries.length === 0) return null;

  const pages = await getNormalizedPages(absPath);
  if (pages.length === 0) return null;

  for (const q of queries) {
    for (const p of pages) {
      if (p.text.includes(q)) return p.num;
    }
  }
  return null;
}
