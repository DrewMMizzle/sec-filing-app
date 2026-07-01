// SEC EDGAR lookups used by the Registration / IPO mode (S-1 / S-1/A and
// Form 10 spin-off registrations).
//
// Scoped to just what the registration flow needs:
//   - lookupCikSubmissions: confirm a CIK, get the official name and tickers.
//   - searchEdgarByName:    surface pre-IPO / spin-off companies by name (those
//                           not in company_tickers.json).
//   - listRegistrationFilings: enumerate the S-1 / S-1/A and Form 10 history
//                           for a CIK.
//   - nameToLabel:          derive a short display label from a company name
//                           when the company has no SEC ticker.

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

export type EdgarCompany = {
  cik: string;
  name: string;
  ticker?: string;
  // True when surfaced via the Form 10 full-text content search (i.e. this
  // company filed a Form 10 whose text matched the query) rather than by
  // ticker/name. Lets the UI flag likely spin-off registrations.
  registrationHint?: boolean;
};

// Registration statements the lane supports: S-1 (IPO) and Form 10
// (10-12B / 10-12G — used for spin-offs), plus their "/A" amendments. EDGAR
// codes Form 10 as "10-12B"/"10-12G", never literally "Form 10" or "10".
export const REGISTRATION_FORMS = new Set([
  "S-1",
  "S-1/A",
  "10-12B",
  "10-12B/A",
  "10-12G",
  "10-12G/A",
]);

export type RegistrationFiling = {
  accessionNumber: string;
  form: string; // e.g. "S-1" | "S-1/A" | "10-12B" | "10-12B/A" | "10-12G"
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

// Parse the EDGAR full-text search response into deduped companies. Each hit is
// a filing; we project it to its filer(s). `limit` caps the result count and
// `hint` stamps registrationHint on every company (used for the Form 10 lane).
function parseEdgarSearchHits(
  data: { hits?: { hits?: Array<{ _source?: { ciks?: unknown; display_names?: unknown } }> } },
  opts: { limit: number; hint?: boolean } = { limit: 10 },
): EdgarCompany[] {
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
      out.push({ cik, name: cleanName, ticker, ...(opts.hint ? { registrationHint: true } : {}) });
      if (out.length >= opts.limit) return out;
    }
  }
  return out;
}

// EDGAR full-text search-index — surfaces companies by name, including pre-IPO
// filers that aren't in company_tickers.json. Returns up to 10 deduped matches.
export async function searchEdgarByName(q: string): Promise<EdgarCompany[]> {
  const query = q.trim();
  if (!query) return [];
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&forms=`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return [];
  const data = await res.json();
  return parseEdgarSearchHits(data, { limit: 10 });
}

// EDGAR full-text search filtered to the registration forms (S-1 + Form 10).
// Because full-text search matches filing CONTENT, this is the bridge from a
// PARENT's name to its spin-off: a spin-off's Form 10 mentions the parent
// throughout, so q="Honeywell" + forms=10-12B… surfaces the spin-off's filer
// (a different entity / CIK / ticker) that name- and ticker-based lookup can't
// reach. Returns those filers tagged with registrationHint.
export async function searchRegistrationFilingsByContent(q: string): Promise<EdgarCompany[]> {
  const query = q.trim();
  if (!query) return [];
  const forms = Array.from(REGISTRATION_FORMS).join(",");
  const url =
    `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}` +
    `&forms=${encodeURIComponent(forms)}`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return [];
  const data = await res.json();
  return parseEdgarSearchHits(data, { limit: 10, hint: true });
}

// List the company's registration-statement history (S-1 / S-1/A and Form 10
// 10-12B / 10-12G + amendments) from its submissions JSON.
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
    if (!REGISTRATION_FORMS.has(form)) continue;
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
