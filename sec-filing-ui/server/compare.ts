import { diffWords } from "diff";
import type { Filing } from "@shared/schema";
import { MODEL, getAnthropicClient, resolvePdfPath, extractPdfText } from "./review";
import type { RegistrationFiling } from "./sec-edgar";

export type SectionKey = "risk_factors" | "mdna" | "legal";

export const SECTION_LABELS: Record<SectionKey, string> = {
  risk_factors: "Risk Factors",
  mdna: "Management's Discussion & Analysis",
  legal: "Legal Proceedings",
};

export type RegistrationSectionKey =
  | "all"
  | "risk_factors"
  | "prospectus_summary"
  | "business"
  | "mdna"
  | "use_of_proceeds"
  | "dilution"
  | "capitalization"
  | "executive_compensation"
  | "underwriting";

export const REGISTRATION_SECTION_LABELS: Record<RegistrationSectionKey, string> = {
  all: "All Material Changes",
  risk_factors: "Risk Factors",
  prospectus_summary: "Prospectus Summary",
  business: "Business",
  mdna: "Management's Discussion & Analysis",
  use_of_proceeds: "Use of Proceeds",
  dilution: "Dilution",
  capitalization: "Capitalization",
  executive_compensation: "Executive Compensation",
  underwriting: "Underwriting",
};

// Heading text used to locate each section. Matched by name (not item number),
// since 10-K and 10-Q number these items differently.
const SECTION_HEADINGS: Record<SectionKey, RegExp> = {
  risk_factors: /risk\s+factors/i,
  mdna: /management[’'`]s\s+discussion\s+and\s+analysis/i,
  legal: /legal\s+proceedings/i,
};

// A section-ending "Item N" header. Anchored to the start of a line so an
// inline cross-reference (e.g. "...the financial statements in Part I, Item 1
// of this report...") — which a 10-Q's MD&A almost always opens with — is NOT
// mistaken for the next section, which would truncate the capture to one line.
const NEXT_ITEM = /\n[^\S\r\n]*item\s+\d+[a-z]?\b[.:)\s]/gi;

const SECTION_MAX_CHARS = 80_000;
const REGISTRATION_SECTION_MAX_CHARS = 120_000;
const REGISTRATION_FULL_MAX_CHARS = 180_000;

const REGISTRATION_SECTION_HEADINGS: Record<Exclude<RegistrationSectionKey, "all">, RegExp> = {
  risk_factors: /risk\s+factors/i,
  prospectus_summary: /prospectus\s+summary/i,
  business: /business/i,
  mdna: /management[’'`]s\s+discussion\s+and\s+analysis/i,
  use_of_proceeds: /use\s+of\s+proceeds/i,
  dilution: /dilution/i,
  capitalization: /capitalization/i,
  executive_compensation: /executive\s+compensation/i,
  underwriting: /underwriting/i,
};

const REGISTRATION_NEXT_HEADING = /\n[^\S\r\n]*(?:prospectus\s+summary|risk\s+factors|use\s+of\s+proceeds|dividend\s+policy|capitalization|dilution|management[’'`]s\s+discussion\s+and\s+analysis|business|management|executive\s+compensation|principal\s+stockholders|certain\s+relationships|related\s+party\s+transactions|description\s+of\s+capital\s+stock|shares\s+eligible\s+for\s+future\s+sale|material\s+u\.?s\.?\s+federal\s+income\s+tax|underwriting|legal\s+matters|experts|where\s+you\s+can\s+find\s+more\s+information|index\s+to\s+financial\s+statements|item\s+\d+[a-z]?)\b/gi;

// Extract a named section from filing text. Heuristic: find each occurrence of
// the heading, capture to the next line-leading "Item N" header, and keep the
// longest capture (the real section, not the short table-of-contents entry).
export function extractSection(
  text: string,
  key: SectionKey,
  maxChars: number = SECTION_MAX_CHARS,
): string | null {
  const heading = new RegExp(SECTION_HEADINGS[key].source, "gi");
  let best = "";
  let m: RegExpExecArray | null;
  while ((m = heading.exec(text)) !== null) {
    const from = m.index;
    NEXT_ITEM.lastIndex = from + 40;
    const next = NEXT_ITEM.exec(text);
    const end = next ? next.index : Math.min(text.length, from + maxChars);
    const body = text.slice(from, end).trim();
    if (body.length > best.length) best = body;
  }
  // The longest candidate filters out short table-of-contents matches; this
  // floor just rejects the case where only a TOC line exists.
  if (best.length < 80) return null;
  return best.slice(0, maxChars);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|tr|table|h[1-6]|li|section|article)\s*>/gi, "\n")
      .replace(/<\s*(p|div|tr|table|h[1-6]|li|section|article)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchSecPrimaryDocumentText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com",
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`SEC primary document returned ${res.status}`);
  return htmlToText(await res.text());
}

function capped(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Truncated at ${maxChars.toLocaleString()} characters for comparison.]`;
}

export function extractRegistrationSection(
  text: string,
  key: Exclude<RegistrationSectionKey, "all">,
  maxChars: number = REGISTRATION_SECTION_MAX_CHARS,
): string | null {
  const heading = new RegExp(REGISTRATION_SECTION_HEADINGS[key].source, "gi");
  let best = "";
  let m: RegExpExecArray | null;
  while ((m = heading.exec(text)) !== null) {
    const from = m.index;
    REGISTRATION_NEXT_HEADING.lastIndex = from + Math.max(m[0].length, 20);
    const next = REGISTRATION_NEXT_HEADING.exec(text);
    const end = next ? next.index : Math.min(text.length, from + maxChars);
    const body = text.slice(from, end).trim();
    if (body.length > best.length) best = body;
  }
  if (best.length < 80) return null;
  return best.slice(0, maxChars);
}

export type DiffSegment = { value: string; added?: boolean; removed?: boolean };

function truncateUnchanged(seg: DiffSegment): DiffSegment {
  if (seg.added || seg.removed) return seg;
  // Collapse long unchanged runs to keep the payload manageable.
  if (seg.value.length > 600) {
    return { value: `${seg.value.slice(0, 300)}\n…\n${seg.value.slice(-300)}` };
  }
  return seg;
}

function computeDiff(earlier: string, later: string): DiffSegment[] {
  const parts = diffWords(earlier, later);
  return parts
    .map((p) => ({ value: p.value, added: p.added || undefined, removed: p.removed || undefined }))
    .map(truncateUnchanged);
}

type ChangeItem = { headline: string; detail: string };
export type Changelog = {
  unchanged: boolean;
  summary: string;
  added: ChangeItem[];
  removed: ChangeItem[];
  changed: ChangeItem[];
};
type Usage = { inputTokens: number; outputTokens: number };

const COMPARE_SYSTEM = `You are comparing the SAME section of two SEC filings from the SAME company, filed at different times, for footnoted.com. Your job is to identify what MATERIALLY changed from the earlier filing to the later one.

Report:
- ADDED: substantive new content (e.g. a brand-new risk factor, a newly disclosed proceeding) present in the later filing but not the earlier one.
- REMOVED: substantive content dropped from the later filing.
- CHANGED: existing content that was materially reworded in a way that changes its meaning, scope, or tone (e.g. softened/strengthened language, new dollar figures, broadened risk).

Ignore pure formatting, reordering, punctuation, and immaterial boilerplate edits. Be specific: name the item and quote or closely paraphrase the relevant language. For each entry, the headline is a punchy description of the change and the detail explains what changed and why a reasonable investor or journalist would care.

If the two sections are essentially the same, set unchanged=true with empty arrays and say so in the summary. Respond ONLY with the structured JSON the schema requires.`;

const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    unchanged: { type: "boolean" },
    summary: { type: "string", description: "1-3 sentence overview of what changed (or that nothing material did)" },
    added: {
      type: "array",
      items: {
        type: "object",
        properties: { headline: { type: "string" }, detail: { type: "string" } },
        required: ["headline", "detail"],
        additionalProperties: false,
      },
    },
    removed: {
      type: "array",
      items: {
        type: "object",
        properties: { headline: { type: "string" }, detail: { type: "string" } },
        required: ["headline", "detail"],
        additionalProperties: false,
      },
    },
    changed: {
      type: "array",
      items: {
        type: "object",
        properties: { headline: { type: "string" }, detail: { type: "string" } },
        required: ["headline", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["unchanged", "summary", "added", "removed", "changed"],
  additionalProperties: false,
};

async function claudeCompare(
  label: string,
  earlier: { form: string; date: string; text: string },
  later: { form: string; date: string; text: string },
): Promise<{ changelog: Changelog; usage: Usage }> {
  const userContent =
    `Section: ${label}\n` +
    `The EARLIER filing is a ${earlier.form} dated ${earlier.date}.\n` +
    `The LATER filing is a ${later.form} dated ${later.date}.\n` +
    `Report what changed from the earlier to the later filing.\n\n` +
    `=== EARLIER (${earlier.form} ${earlier.date}) ===\n${earlier.text}\n\n` +
    `=== LATER (${later.form} ${later.date}) ===\n${later.text}`;

  const stream = getAnthropicClient().messages.stream({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: COMPARE_SCHEMA } },
    system: [{ type: "text", text: COMPARE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No text block in comparison response");
  const parsed = JSON.parse(textBlock.text) as Partial<Changelog>;
  const u = message.usage;
  return {
    changelog: {
      unchanged: !!parsed.unchanged,
      summary: parsed.summary || "",
      added: Array.isArray(parsed.added) ? parsed.added : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed : [],
      changed: Array.isArray(parsed.changed) ? parsed.changed : [],
    },
    usage: { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 },
  };
}

export type CompareResult = {
  section: SectionKey;
  sectionLabel: string;
  earlier: { accession: string; ticker: string; form: string; date: string; found: boolean };
  later: { accession: string; ticker: string; form: string; date: string; found: boolean };
  diff: DiffSegment[] | null;
  changelog: Changelog | null;
  costUsd: number;
  note?: string;
};

export async function compareFilings(a: Filing, b: Filing, key: SectionKey): Promise<CompareResult> {
  // Order by filing date (older = earlier)
  const [earlierF, laterF] =
    (a.filingDate || "") <= (b.filingDate || "") ? [a, b] : [b, a];

  const meta = (f: Filing) => ({
    accession: f.accessionNumber,
    ticker: f.ticker,
    form: f.filingType,
    date: f.filingDate || "unknown",
  });

  const pathE = resolvePdfPath(earlierF);
  const pathL = resolvePdfPath(laterF);
  if (!pathE || !pathL) {
    throw new Error(
      "The rendered PDF is missing for one of these filings (storage was likely cleared on a redeploy). Re-pull this company with “Load last 3 years” to regenerate the PDFs, then compare again.",
    );
  }

  const [textE, textL] = await Promise.all([extractPdfText(pathE), extractPdfText(pathL)]);
  const secE = extractSection(textE, key);
  const secL = extractSection(textL, key);

  const result: CompareResult = {
    section: key,
    sectionLabel: SECTION_LABELS[key],
    earlier: { ...meta(earlierF), found: !!secE },
    later: { ...meta(laterF), found: !!secL },
    diff: null,
    changelog: null,
    costUsd: 0,
  };

  if (!secE || !secL) {
    const missing = [!secE ? `the ${earlierF.filingType}` : null, !secL ? `the ${laterF.filingType}` : null]
      .filter(Boolean)
      .join(" and ");
    result.note = `Couldn't locate the "${SECTION_LABELS[key]}" section in ${missing}. Extraction from rendered PDFs is approximate and can miss non-standard formatting.`;
    return result;
  }

  result.diff = computeDiff(secE, secL);

  const { changelog, usage } = await claudeCompare(
    SECTION_LABELS[key],
    { form: earlierF.filingType, date: earlierF.filingDate || "unknown", text: secE },
    { form: laterF.filingType, date: laterF.filingDate || "unknown", text: secL },
  );
  result.changelog = changelog;
  result.costUsd = Math.round(((usage.inputTokens * 5 + usage.outputTokens * 25) / 1_000_000) * 100) / 100;
  return result;
}

export type RegistrationCompareResult = {
  section: RegistrationSectionKey;
  sectionLabel: string;
  earlier: { accession: string; form: string; date: string; found: boolean; sourceUrl: string };
  later: { accession: string; form: string; date: string; found: boolean; sourceUrl: string };
  diff: DiffSegment[] | null;
  changelog: Changelog | null;
  costUsd: number;
  note?: string;
};

export async function compareRegistrationFilings(
  a: RegistrationFiling,
  b: RegistrationFiling,
  key: RegistrationSectionKey,
): Promise<RegistrationCompareResult> {
  const [earlierF, laterF] =
    (a.filingDate || "") <= (b.filingDate || "") ? [a, b] : [b, a];
  const label = REGISTRATION_SECTION_LABELS[key];
  const meta = (f: RegistrationFiling) => ({
    accession: f.accessionNumber,
    form: f.form,
    date: f.filingDate || "unknown",
    found: false,
    sourceUrl: f.primaryDocUrl,
  });

  const result: RegistrationCompareResult = {
    section: key,
    sectionLabel: label,
    earlier: meta(earlierF),
    later: meta(laterF),
    diff: null,
    changelog: null,
    costUsd: 0,
  };

  const [textE, textL] = await Promise.all([
    fetchSecPrimaryDocumentText(earlierF.primaryDocUrl),
    fetchSecPrimaryDocumentText(laterF.primaryDocUrl),
  ]);
  const secE =
    key === "all" ? capped(textE, REGISTRATION_FULL_MAX_CHARS) : extractRegistrationSection(textE, key);
  const secL =
    key === "all" ? capped(textL, REGISTRATION_FULL_MAX_CHARS) : extractRegistrationSection(textL, key);

  result.earlier.found = !!secE;
  result.later.found = !!secL;

  if (!secE || !secL) {
    const missing = [!secE ? `the ${earlierF.form}` : null, !secL ? `the ${laterF.form}` : null]
      .filter(Boolean)
      .join(" and ");
    result.note = `Couldn't locate the "${label}" section in ${missing}. Try "All Material Changes" for a broader SEC HTML comparison.`;
    return result;
  }

  result.diff = key === "all" ? null : computeDiff(secE, secL);
  const { changelog, usage } = await claudeCompare(
    key === "all" ? `${label} (SEC primary document HTML text)` : label,
    { form: earlierF.form, date: earlierF.filingDate || "unknown", text: secE },
    { form: laterF.form, date: laterF.filingDate || "unknown", text: secL },
  );
  result.changelog = changelog;
  result.costUsd = Math.round(((usage.inputTokens * 5 + usage.outputTokens * 25) / 1_000_000) * 100) / 100;
  if (key === "all") {
    result.note =
      "Compared SEC primary document HTML directly. Long filings are capped before Claude analysis to keep the request bounded.";
  }
  return result;
}
