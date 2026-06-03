// SEC EDGAR lookups beyond the static company_tickers.json file — used for
// pre-IPO companies that have a CIK but no ticker yet.

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

export type EdgarCompany = { cik: string; name: string; ticker?: string };

// Fetch a single company's submissions JSON to confirm a CIK and grab the
// official name and any tickers the company has. Returns null if the CIK
// doesn't resolve (404 from SEC), so the caller can decline cleanly.
export async function lookupCikSubmissions(
  cik: string,
): Promise<{ cik: string; name: string; tickers: string[] } | null> {
  const digits = (cik || "").replace(/\D/g, "");
  if (!digits || digits.length > 10) return null;
  const padded = digits.padStart(10, "0");
  if (padded === "0000000000") return null;
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return null;
  const data = (await res.json()) as { name?: string; entityName?: string; tickers?: unknown };
  const name = (data.name || data.entityName || "").trim();
  const tickers = Array.isArray(data.tickers)
    ? (data.tickers as unknown[]).filter((t): t is string => typeof t === "string" && !!t)
    : [];
  return { cik: padded, name, tickers };
}

// EDGAR full-text search-index — the same backend that powers efts.sec.gov.
// We use it to surface companies by name (including pre-IPO ones that aren't
// in company_tickers.json). Returns deduped companies, capped at 10.
export async function searchEdgarByName(q: string): Promise<EdgarCompany[]> {
  const query = q.trim();
  if (!query) return [];
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    hits?: { hits?: Array<{ _source?: { ciks?: unknown; display_names?: unknown } }> };
  };
  const hits = data?.hits?.hits ?? [];
  const seen = new Set<string>();
  const out: EdgarCompany[] = [];
  for (const hit of hits) {
    const ciks = Array.isArray(hit._source?.ciks) ? (hit._source!.ciks as unknown[]) : [];
    const names = Array.isArray(hit._source?.display_names)
      ? (hit._source!.display_names as unknown[])
      : [];
    for (let i = 0; i < ciks.length && i < names.length; i++) {
      const cikRaw = ciks[i];
      const nameRaw = names[i];
      if (typeof cikRaw !== "string" || typeof nameRaw !== "string") continue;
      const cik = cikRaw.padStart(10, "0");
      if (seen.has(cik)) continue;
      seen.add(cik);
      // display_names format: "ACME CORP  (ACME, CIK 0001234567)" — strip the
      // trailing parenthetical so we keep just the human name + ticker.
      const m = nameRaw.match(/^(.+?)\s+\(([^,]*),\s*CIK\s+\d+\)/);
      const cleanName = (m ? m[1] : nameRaw).trim();
      const tickerHint = m ? m[2].trim() : "";
      const ticker = tickerHint && tickerHint !== "—" ? tickerHint : undefined;
      out.push({ cik, name: cleanName, ticker });
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// Derive a short, ALL-CAPS display label from a company name when we don't
// have a real ticker (pre-IPO). E.g. "Acme Technologies, Inc." -> "ACME".
export function nameToLabel(name: string): string {
  const tokens = (name || "")
    .toUpperCase()
    .replace(/[.,()/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Drop common corporate suffixes so the label isn't "INC" or "THE".
  const SUFFIXES = new Set([
    "THE", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "LLC", "LTD", "PLC",
    "HOLDINGS", "GROUP", "TRUST", "FUND",
  ]);
  const first = tokens.find((t) => !SUFFIXES.has(t)) ?? tokens[0] ?? "";
  const clean = first.replace(/[^A-Z0-9]/g, "");
  return (clean || "PREIPO").slice(0, 8);
}
