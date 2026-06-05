// SEC EDGAR lookups used by the Registration / IPO mode (S-1 / S-1/A).
//
// Scoped to just what the registration flow needs:
//   - lookupCikSubmissions: confirm a CIK, get the official name and tickers.
//   - searchEdgarByName:    surface pre-IPO companies by name (those not in
//                           company_tickers.json).
//   - listRegistrationFilings: enumerate the S-1 / S-1/A history for a CIK.
//   - nameToLabel:          derive a short display label from a company name
//                           when the company has no SEC ticker.

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

export type EdgarCompany = { cik: string; name: string; ticker?: string };

export type RegistrationFiling = {
  accessionNumber: string;
  form: string; // "S-1" | "S-1/A"
  filingDate: string; // YYYY-MM-DD
  primaryDocUrl: string;
};

// Fetch a single company's submissions JSON to confirm a CIK and grab the
// official name and any tickers.
export async function lookupCikSubmissions(
  cik: string,
): Promise<{ cik: string; name: string; tickers: string[] } | null> {
  const padded = paddedCik(cik);
  if (!padded) return null;
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

// EDGAR full-text search-index — surfaces companies by name, including pre-IPO
// filers that aren't in company_tickers.json. Returns up to 10 deduped matches.
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
      // display_names format: "ACME CORP  (ACME, CIK 0001234567)"
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

// List the company's S-1 and S-1/A history from its submissions JSON.
export async function listRegistrationFilings(cik: string): Promise<RegistrationFiling[]> {
  const padded = paddedCik(cik);
  if (!padded) return [];
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    filings?: { recent?: Record<string, unknown[]> };
  };
  const recent = data?.filings?.recent;
  if (!recent) return [];
  const forms = (recent.form as unknown[] | undefined) ?? [];
  const accessions = (recent.accessionNumber as unknown[] | undefined) ?? [];
  const dates = (recent.filingDate as unknown[] | undefined) ?? [];
  const primaryDocs = (recent.primaryDocument as unknown[] | undefined) ?? [];

  const cikStripped = padded.replace(/^0+/, "") || "0";
  const out: RegistrationFiling[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = String(forms[i] ?? "");
    if (form !== "S-1" && form !== "S-1/A") continue;
    const acc = String(accessions[i] ?? "");
    const date = String(dates[i] ?? "");
    const primary = String(primaryDocs[i] ?? "");
    if (!acc || !primary) continue;
    const accNoDash = acc.replace(/-/g, "");
    const primaryDocUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accNoDash}/${primary}`;
    out.push({
      accessionNumber: acc,
      form,
      filingDate: date,
      primaryDocUrl,
    });
  }
  // Newest first.
  out.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  return out;
}

// Derive a short ALL-CAPS label from a company name. Used as the `ticker`
// field on the filings row for pre-IPO companies that have no SEC ticker
// yet. This is the documented compromise — the schema's `ticker` column
// is repurposed as a display label for pre-IPO rows, scoped to the
// registration lane only.
export function nameToLabel(name: string): string {
  const SUFFIXES = new Set([
    "THE", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "LLC", "LTD", "PLC",
    "HOLDINGS", "GROUP", "TRUST", "FUND",
  ]);
  const tokens = (name || "")
    .toUpperCase()
    .replace(/[.,()/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const first = tokens.find((t) => !SUFFIXES.has(t)) ?? tokens[0] ?? "";
  return (first.replace(/[^A-Z0-9]/g, "") || "PREIPO").slice(0, 8);
}

function paddedCik(cik: string): string | null {
  const digits = (cik || "").replace(/\D/g, "");
  if (!digits || digits.length > 10) return null;
  const padded = digits.padStart(10, "0");
  if (padded === "0000000000") return null;
  return padded;
}
