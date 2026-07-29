// Shared, lazy cache of SEC's company_tickers.json so callers don't each pull
// it independently. Used by the chat entity-scoping heuristic and by the
// quick-fetch ticker resolver on Fetch & Review.
const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

export type SecTickerEntry = { cik: string; name: string };

let _cache: Promise<Map<string, SecTickerEntry>> | null = null;

export type SecCompanyMatch = { cik: string; name: string; ticker: string };

// Look up listed companies by NAME, not symbol.
//
// getSecTickerIndex is keyed on ticker, so a search for "Honeywell" or
// "Berkshire" misses it entirely and has to fall through to EDGAR full-text
// search — which indexes filing bodies, not filers, and so returns whoever
// happens to mention the name. This scans the same already-cached index by
// company title, which answers the common case (a listed company searched by
// its name) directly and correctly.
//
// Ranking: exact title, then prefix, then substring. Inside a tier, shorter
// titles first — a search for "Apple" should surface "Apple Inc." above
// "Apple Hospitality REIT, Inc." — then alphabetical so ties stay stable.
export async function searchSecTickerIndexByName(
  query: string,
  limit = 10,
): Promise<SecCompanyMatch[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const idx = await getSecTickerIndex();

  const scored: Array<{ m: SecCompanyMatch; rank: number }> = [];
  for (const [ticker, entry] of Array.from(idx.entries())) {
    const name = entry.name.toLowerCase();
    if (!name) continue;
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : -1;
    if (rank < 0) continue;
    scored.push({ m: { cik: entry.cik, name: entry.name, ticker }, rank });
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.m.name.length - b.m.name.length ||
      a.m.name.localeCompare(b.m.name),
  );
  return scored.slice(0, limit).map((s) => s.m);
}

export async function getSecTickerIndex(): Promise<Map<string, SecTickerEntry>> {
  if (_cache) return _cache;
  _cache = (async () => {
    try {
      const res = await fetch(SEC_COMPANY_TICKERS_URL, {
        headers: { "User-Agent": SEC_USER_AGENT },
      });
      if (!res.ok) throw new Error(`SEC company_tickers returned ${res.status}`);
      const data = (await res.json()) as Record<
        string,
        { cik_str: number; ticker: string; title: string }
      >;
      const m = new Map<string, SecTickerEntry>();
      for (const e of Object.values(data)) {
        if (e.ticker) {
          m.set(e.ticker.toUpperCase(), {
            cik: String(e.cik_str).padStart(10, "0"),
            name: e.title || "",
          });
        }
      }
      return m;
    } catch (err) {
      _cache = null;
      throw err;
    }
  })();
  return _cache;
}
