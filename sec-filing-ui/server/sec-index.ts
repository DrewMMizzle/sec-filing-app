// Shared, lazy cache of SEC's company_tickers.json so callers don't each pull
// it independently. Used by the chat entity-scoping heuristic and by the
// quick-fetch ticker resolver on Fetch & Review.
const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

export type SecTickerEntry = { cik: string; name: string };

let _cache: Promise<Map<string, SecTickerEntry>> | null = null;

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
