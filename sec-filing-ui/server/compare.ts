import { diffWords } from "diff";
import type { Filing } from "@shared/schema";
import { MODEL, getAnthropicClient, resolvePdfPath, extractPdfText } from "./review";

export type SectionKey = "risk_factors" | "mdna" | "legal";

export const SECTION_LABELS: Record<SectionKey, string> = {
  risk_factors: "Risk Factors",
  mdna: "Management's Discussion & Analysis",
  legal: "Legal Proceedings",
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

// ───────────────────────────────────────────────────────────
// Registration / IPO — whole-filing comparison (S-1 vs S-1/A).
//
// Differs from compareFilings above in two material ways:
//
//   1. Always uses the rendered PDF text via extractPdfText. The user
//      asked specifically for full-filing comparison rather than per-
//      section, so we don't try to extract sections — the whole
//      document is the input.
//   2. Front / middle / back sampling per filing so a 600-page S-1 fits
//      in Opus 4.7's standard 200k-token context. Two filings × 400k
//      chars ≈ 200k tokens combined, leaving room for the prompt.
//      Sampling rather than truncating-the-front keeps coverage of
//      back-half sections (Underwriting, Financial Statements,
//      Executive Compensation) where S-1/A amendments tend to add
//      material changes.
// ───────────────────────────────────────────────────────────

const REGISTRATION_FULL_MAX_CHARS_PER_FILING = 400_000; // ~100k tokens
const REGISTRATION_COMPARE_SYSTEM = `You are comparing two related SEC registration statements from the SAME company (typically an S-1 and its S-1/A amendment, or two successive S-1/A amendments), filed at different times, for footnoted.com. Your job is to identify what MATERIALLY changed across the WHOLE filing from the earlier filing to the later one.

Report:
- ADDED: substantively new sections, disclosures, or details present in the later filing but not the earlier (e.g. new risk factors, a newly disclosed proceeding, new related-party transactions, newly disclosed dollar figures or share counts).
- REMOVED: substantive content present in the earlier filing but dropped from the later.
- CHANGED: existing content that was materially reworded so it changes meaning, scope, or tone (e.g. softened or strengthened risk language, updated dollar figures, broadened/narrowed scope, lock-up periods adjusted, offering size revised).

Ignore pure formatting differences, reordering, punctuation, and immaterial boilerplate edits. Be specific: name the area of the document (e.g. "Risk Factors", "Use of Proceeds", "Capitalization table", "Executive Compensation – Summary Compensation Table", "Underwriting") and quote or closely paraphrase the relevant language. For each entry, the headline is a punchy description of the change and the detail explains what changed and why a reasonable investor or journalist would care.

If the two filings are essentially the same, set unchanged=true with empty arrays and say so in the summary. Respond ONLY with the structured JSON the schema requires.

Note: filings are long. Each side of the comparison is presented as three concatenated slices — front, middle, and back of the document — to fit in context. If you only see partial coverage of a section, say so in the summary rather than fabricating content.`;

// Front / middle / back sampling, balanced so the budget is split
// equally across the document. Mirrors the technique compareFilings uses
// for section extraction but applied at whole-filing scale.
function sampleRegistrationText(text: string, perFilingMax: number): string {
  if (text.length <= perFilingMax) return text;
  const perSlice = Math.floor(perFilingMax / 3);
  const mid = Math.max(0, Math.floor(text.length / 2) - Math.floor(perSlice / 2));
  return [
    "[Front of the filing:]",
    text.slice(0, perSlice).trim(),
    "\n[Middle of the filing:]",
    text.slice(mid, mid + perSlice).trim(),
    "\n[Back of the filing:]",
    text.slice(text.length - perSlice).trim(),
  ].join("\n\n");
}

export type RegistrationCompareResult = {
  earlier: { accession: string; ticker: string; form: string; date: string; chars: number };
  later: { accession: string; ticker: string; form: string; date: string; chars: number };
  changelog: Changelog | null;
  costUsd: number;
  sampled: boolean;
  note?: string;
};

export async function compareRegistrationFilingsFromPdfs(
  a: Filing,
  b: Filing,
): Promise<RegistrationCompareResult> {
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
      "Both filings must be rendered to PDF before comparison. Use Render selected on the missing one(s) first.",
    );
  }

  const [textE, textL] = await Promise.all([extractPdfText(pathE), extractPdfText(pathL)]);
  const sampledE = sampleRegistrationText(textE, REGISTRATION_FULL_MAX_CHARS_PER_FILING);
  const sampledL = sampleRegistrationText(textL, REGISTRATION_FULL_MAX_CHARS_PER_FILING);
  const wasSampled =
    textE.length > REGISTRATION_FULL_MAX_CHARS_PER_FILING ||
    textL.length > REGISTRATION_FULL_MAX_CHARS_PER_FILING;

  const userContent =
    `Comparing two related SEC registration statements from the same company.\n` +
    `The EARLIER filing is a ${earlierF.filingType} dated ${earlierF.filingDate || "unknown"}.\n` +
    `The LATER filing is a ${laterF.filingType} dated ${laterF.filingDate || "unknown"}.\n` +
    `Report what materially changed from the earlier to the later filing across the whole document.\n\n` +
    `=== EARLIER (${earlierF.filingType} ${earlierF.filingDate || "unknown"}) ===\n${sampledE}\n\n` +
    `=== LATER (${laterF.filingType} ${laterF.filingDate || "unknown"}) ===\n${sampledL}`;

  const stream = getAnthropicClient().messages.stream({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: { type: "json_schema", schema: COMPARE_SCHEMA } },
    system: [{ type: "text", text: REGISTRATION_COMPARE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text block in registration compare response");
  }
  const parsed = JSON.parse(textBlock.text) as Partial<Changelog>;
  const u = message.usage;
  const usage: Usage = { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 };

  const changelog: Changelog = {
    unchanged: !!parsed.unchanged,
    summary: parsed.summary || "",
    added: Array.isArray(parsed.added) ? parsed.added : [],
    removed: Array.isArray(parsed.removed) ? parsed.removed : [],
    changed: Array.isArray(parsed.changed) ? parsed.changed : [],
  };

  return {
    earlier: { ...meta(earlierF), chars: textE.length },
    later: { ...meta(laterF), chars: textL.length },
    changelog,
    costUsd:
      Math.round(((usage.inputTokens * 5 + usage.outputTokens * 25) / 1_000_000) * 100) / 100,
    sampled: wasSampled,
    note: wasSampled
      ? `Long filing — sampled front / middle / back at ~${REGISTRATION_FULL_MAX_CHARS_PER_FILING.toLocaleString()} chars per filing so the comparison fits in Claude's context window.`
      : undefined,
  };
}
