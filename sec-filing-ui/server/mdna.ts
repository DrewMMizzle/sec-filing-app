import type { Filing } from "@shared/schema";
import { MODEL, getAnthropicClient, resolvePdfPath, extractPdfText } from "./review";
import { extractSection, countSectionHeadings, normalizeFilingText } from "./compare";
import { UNTRUSTED_CONTENT_GUIDANCE, wrapUntrustedFiling, extractModelText } from "./prompt-safety";

// The MD&A digest is for stock-research analysts: it pulls the operating story
// out of Management's Discussion & Analysis (10-K Item 7 / 10-Q Item 2) —
// revenue drivers (price/volume/FX/mix), margin variance, segment results, and
// guidance — which the editorial "gotcha" review deliberately ignores.

const MDNA_MAX_CHARS = 150_000; // ~37k tokens — comfortably fits a full MD&A.
// Floor for a plausible MD&A body. extractSection's own floor is 80 chars,
// which is deliberately permissive because a 10-Q's Risk Factors legitimately
// can be one line ("no material changes"). An MD&A never is.
const MDNA_MIN_CHARS = 1_500;
const MDNA_TIMEOUT_MS = 5 * 60 * 1000;

// Forms that carry an MD&A section.
export function isMdnaEligible(filingType: string): boolean {
  const t = filingType.toUpperCase();
  return t.startsWith("10-K") || t.startsWith("10-Q");
}

export type RevenueDriver = { factor: string; impact: string; detail: string };
export type Segment = { name: string; revenue: string; profit: string; commentary: string };
export type MdnaDigest = {
  available: boolean;
  period: string;
  overview: string;
  revenue_drivers: RevenueDriver[];
  margins: { gross: string; operating: string; commentary: string };
  segments: Segment[];
  guidance: string;
  other: string[];
};

const MDNA_SCHEMA = {
  type: "object",
  properties: {
    available: {
      type: "boolean",
      description: "True if a real MD&A section was found and analyzed; false if the text wasn't an MD&A or was empty.",
    },
    period: {
      type: "string",
      description: "Reporting period the MD&A covers, e.g. 'Q1 FY2026' or 'FY2025'. Empty if unclear.",
    },
    overview: {
      type: "string",
      description: "2–4 sentence narrative of how the business performed this period, in management's framing.",
    },
    revenue_drivers: {
      type: "array",
      description: "Decomposition of the revenue change, ONLY as management attributes it.",
      items: {
        type: "object",
        properties: {
          factor: {
            type: "string",
            enum: ["price", "volume", "fx", "mix", "acquisition", "divestiture", "organic", "other"],
          },
          impact: {
            type: "string",
            description: "Direction/size, quoting the figure management gives, e.g. '+3.2%', '-$120M', 'favorable'.",
          },
          detail: { type: "string", description: "Management's explanation, quoting concrete language/numbers." },
        },
        required: ["factor", "impact", "detail"],
        additionalProperties: false,
      },
    },
    margins: {
      type: "object",
      properties: {
        gross: { type: "string", description: "Gross margin level and YoY change with management's reasons. Empty if not disclosed." },
        operating: { type: "string", description: "Operating margin level and change with reasons. Empty if not disclosed." },
        commentary: { type: "string", description: "Other cost/margin notes (input costs, opex leverage, pricing). Empty if none." },
      },
      required: ["gross", "operating", "commentary"],
      additionalProperties: false,
    },
    segments: {
      type: "array",
      description: "Per reporting-segment results as discussed by management.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          revenue: { type: "string", description: "Segment revenue and YoY change; quote figures." },
          profit: { type: "string", description: "Segment operating income/profit and change. Empty if not given." },
          commentary: { type: "string", description: "What drove the segment." },
        },
        required: ["name", "revenue", "profit", "commentary"],
        additionalProperties: false,
      },
    },
    guidance: {
      type: "string",
      description: "Any outlook/guidance management provides or revises, quoting specifics. Empty if none.",
    },
    other: {
      type: "array",
      description: "Other operationally material points (liquidity, capex, FX exposure, restructuring, one-time items).",
      items: { type: "string" },
    },
  },
  required: ["available", "period", "overview", "revenue_drivers", "margins", "segments", "guidance", "other"],
  additionalProperties: false,
} as const;

const MDNA_SYSTEM_PROMPT = `You are an equity research analyst extracting the operating story from the Management's Discussion & Analysis (MD&A) of an SEC filing (10-K Item 7 or 10-Q Item 2). Your audience is buy-side and sell-side analysts who want to know what actually drove the numbers this period.

Extract, concretely and quantitatively:
- overview: how the business performed this period, in management's framing.
- revenue_drivers: decompose the revenue change into price, volume, FX, mix, acquisitions/divestitures, organic, etc. — but ONLY as management attributes it. Quote the figures/percentages they give.
- margins: gross and operating margin levels, their change, and the reasons management cites (input costs, pricing, mix, opex leverage).
- segments: each reporting segment's revenue and profit with the change and what drove it.
- guidance: any outlook or guidance management provides or revises.
- other: anything else operationally material (liquidity, capex, FX exposure, restructuring, one-time items).

Rules:
- Base everything ONLY on the MD&A text provided. Never pull in outside knowledge or infer a driver management didn't state.
- Quote concrete numbers and management's own language wherever possible.
- If a field isn't disclosed, leave its string empty or its array empty — do NOT fabricate, and do NOT force a price/volume split management didn't give.
- If the provided text isn't actually an MD&A section (or is empty), set available=false and leave everything else empty.

${UNTRUSTED_CONTENT_GUIDANCE}`;

export type MdnaResult = {
  digest: MdnaDigest;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
};

const EMPTY_DIGEST: MdnaDigest = {
  available: false,
  period: "",
  overview: "",
  revenue_drivers: [],
  margins: { gross: "", operating: "", commentary: "" },
  segments: [],
  guidance: "",
  other: [],
};

// When the heading pattern fails, report what weaker signals DO appear so the
// next failure identifies itself instead of costing another round trip. Each
// probe strips one more requirement off the full heading, so the first one
// that fires says which part of the spelling is the problem — and the sample
// shows the surrounding text verbatim, which beats guessing at characters.
function probeMdnaHeadings(raw: string): string {
  const text = normalizeFilingText(raw);
  const count = (re: RegExp) => (text.match(new RegExp(re.source, "gi")) ?? []).length;
  const probes: Array<[string, RegExp]> = [
    ["'discussion and/& analysis'", /discussion\s*(?:and|&)\s*analysis/],
    ["'discussion'", /discussion/],
    ["line-leading 'Item 2'", /\n[^\S\r\n]*item\s+2\b/],
  ];
  const counts = probes.map(([label, re]) => `${label} x${count(re)}`).join(", ");

  // A window around the last 'discussion' occurrence — the body header, if it
  // is there at all, is far more likely to be the last one than the TOC entry.
  const all = Array.from(text.matchAll(/discussion/gi));
  const last = all[all.length - 1];
  const sample =
    last === undefined
      ? ""
      : ` Text near the last 'discussion': "${text
          .slice(Math.max(0, last.index - 70), last.index + 90)
          .replace(/\s+/g, " ")
          .trim()}".`;
  return `Probes: ${counts}.${sample}`;
}

// Run the MD&A digest for one filing. Throws on hard failures (missing PDF, no
// MD&A section, Claude error) so the caller can persist an error state.
export async function analyzeMdna(filing: Filing): Promise<MdnaResult> {
  if (!isMdnaEligible(filing.filingType)) {
    throw new Error(`MD&A analysis only applies to 10-K and 10-Q filings (got ${filing.filingType}).`);
  }
  const pdfPath = resolvePdfPath(filing);
  if (!pdfPath) {
    throw new Error(
      "Rendered PDF is missing on disk (storage may have been cleared on a redeploy). Re-fetch this filing to regenerate it.",
    );
  }
  const fullText = await extractPdfText(pdfPath);
  // Every 10-K and 10-Q carries a substantial MD&A — that's what isMdnaEligible
  // gates on — so anything shorter than MDNA_MIN_CHARS is a table-of-contents
  // entry or a stray cross-reference rather than the section. Passing the floor
  // to extractSection makes it skip those occurrences instead of returning the
  // longest one, so a TOC line can't masquerade as the body.
  const section = extractSection(fullText, "mdna", MDNA_MAX_CHARS, MDNA_MIN_CHARS);
  if (!section) {
    // Say which failure this is. The three causes need different responses and
    // are indistinguishable from "could not locate an MD&A section":
    //   headings 0        -> the heading spelling isn't matched (a pattern bug)
    //   headings 1        -> only the TOC entry is present; the body never made
    //                        it into the PDF, so this is a render problem
    //   headings 2+, short-> the body is there but the section boundary is
    //                        landing in the wrong place (an extractor bug)
    // The character counts are here so a screenshot of the error is enough to
    // tell them apart without production access.
    const headings = countSectionHeadings(fullText, "mdna");
    const loose = extractSection(fullText, "mdna", MDNA_MAX_CHARS);
    const detail =
      headings === 0
        ? "the MD&A heading was not found anywhere in the text"
        : headings === 1
          ? "the MD&A heading appears only once — likely the table-of-contents entry, " +
            "with the body header spelled differently or the body missing"
          : `the MD&A heading appears ${headings} times but the longest section body ` +
            `found was only ${loose?.length ?? 0} characters`;
    throw new Error(
      `Could not extract an MD&A section from this filing: ${detail}. ` +
        `The filing's extracted text is ${fullText.length.toLocaleString()} characters. ` +
        `${probeMdnaHeadings(fullText)} ` +
        "Re-render the filing and try again.",
    );
  }

  const userContent =
    `Filing: ${filing.ticker} ${filing.filingType} ${filing.filingDate || ""} (accession ${filing.accessionNumber})\n\n` +
    `MD&A section text:\n${wrapUntrustedFiling(section, `${filing.ticker} ${filing.filingType} MD&A`)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MDNA_TIMEOUT_MS);
  let message;
  try {
    const stream = getAnthropicClient().messages.stream(
      {
        model: MODEL,
        // Thinking and the response share this budget on Opus 5. At 8000 the
        // model spent it thinking and the JSON came back cut off mid-string,
        // surfacing as "Unterminated string in JSON" and "no text block in
        // model response". Streaming, so a large ceiling costs nothing.
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: MDNA_SCHEMA },
        },
        system: [{ type: "text", text: MDNA_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      },
      { signal: controller.signal },
    );
    message = await stream.finalMessage();
  } catch (err: any) {
    if (controller.signal.aborted) {
      throw new Error(`MD&A analysis timed out after ${Math.round(MDNA_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const parsed = JSON.parse(extractModelText(message, "MD&A analysis")) as Partial<MdnaDigest>;
  const digest: MdnaDigest = {
    ...EMPTY_DIGEST,
    ...parsed,
    margins: { ...EMPTY_DIGEST.margins, ...(parsed.margins ?? {}) },
    revenue_drivers: Array.isArray(parsed.revenue_drivers) ? parsed.revenue_drivers : [],
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    other: Array.isArray(parsed.other) ? parsed.other : [],
  };
  const u = message.usage;
  return {
    digest,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    },
  };
}
