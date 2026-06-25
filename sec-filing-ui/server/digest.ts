// Reusable "AI reading" of a single filing (chat cache).
//
// The "Ask this filing" deep-dive otherwise re-sends the full ~500k-token PDF
// text to Claude on every new session. This module generates a compact,
// structured digest of the filing ONCE, persists it (filings.filing_digest),
// and the chat answers routine questions from that digest — a few thousand
// tokens — instead of the whole document. The full-text path is still reachable
// for deep questions the digest can't cover (chatAboutFiling's `deep` option).
//
// Generated with Sonnet 4.6: cheaper than Opus ($3/$15 vs $5/$25 per 1M) for a
// comprehension/summarize pass, and it has the same 1M-token context window.

import type { Filing } from "@shared/schema";
import { getAnthropicClient, resolvePdfPath, extractPdfText } from "./review";
import { storage } from "./storage";
import { wrapUntrustedFiling, extractModelText, UNTRUSTED_CONTENT_GUIDANCE } from "./prompt-safety";

const DIGEST_MODEL = "claude-sonnet-4-6";
// Mirror chat.ts MAX_FILING_CHARS so the digest sees the same source the
// full-text chat would.
const DIGEST_MAX_CHARS = 2_000_000;
const DIGEST_TIMEOUT_MS = 5 * 60 * 1000;
// Sonnet 4.6 pricing (USD per 1M tokens) for the [digest] cost log line.
const DIGEST_PRICE_INPUT = 3;
const DIGEST_PRICE_OUTPUT = 15;

export type FilingDigest = {
  overview: string;
  sections: Array<{ name: string; summary: string }>;
  keyFigures: Array<{ label: string; value: string; context: string }>;
  notableItems: Array<{ category: string; detail: string }>;
  coverage: string;
};

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    overview: {
      type: "string",
      description: "3-6 sentence plain-language summary of what this filing is and its most notable contents",
    },
    sections: {
      type: "array",
      description: "Map of the filing's major sections, each with a substantive summary",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Section name, e.g. 'Risk Factors', 'MD&A', 'Executive Compensation'" },
          summary: { type: "string", description: "What the section covers, with the specifics an editor would ask about" },
        },
        required: ["name", "summary"],
        additionalProperties: false,
      },
    },
    keyFigures: {
      type: "array",
      description: "Notable numbers (dollar amounts, share counts, percentages, dates) a reader is likely to ask about",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          context: { type: "string", description: "Where it appears / what it refers to" },
        },
        required: ["label", "value", "context"],
        additionalProperties: false,
      },
    },
    notableItems: {
      type: "array",
      description: "Buried, post-worthy specifics — perks, severance, related-party, governance/accounting tells — quoting or closely paraphrasing the language",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          detail: { type: "string" },
        },
        required: ["category", "detail"],
        additionalProperties: false,
      },
    },
    coverage: {
      type: "string",
      description: "One sentence on what this digest does and does NOT capture, so a downstream reader knows when to consult the full filing",
    },
  },
  required: ["overview", "sections", "keyFigures", "notableItems", "coverage"],
  additionalProperties: false,
};

const DIGEST_SYSTEM = `You are building a reusable digest of a single SEC filing for footnoted.com editors. This digest is generated once and then used to answer many later questions about the filing WITHOUT re-reading the full document, so it must be thorough and faithful.

Capture: an overview; a section-by-section map of the whole document (Risk Factors, MD&A, Legal Proceedings, Executive Compensation, Related-Party Transactions, Underwriting, etc. — whatever is present); the key figures (dollar amounts, share counts, percentages, dates) a reader is likely to ask about, each with where it appears; and the buried, post-worthy specifics footnoted cares about (perks, severance/parachutes, related-party dealings, governance/accounting tells), quoting or closely paraphrasing the actual language.

Be comprehensive but strictly factual — never invent figures, names, or language that isn't in the filing. In the coverage field, state plainly what the digest does and does not capture so a later reader knows when the full filing must be consulted. Respond ONLY with the structured JSON the schema requires.

${UNTRUSTED_CONTENT_GUIDANCE}`;

type DigestUsage = { inputTokens: number; outputTokens: number };

export async function generateFilingDigest(
  filing: Filing,
  fullText: string,
): Promise<{ digest: FilingDigest; usage: DigestUsage }> {
  const body = fullText.length > DIGEST_MAX_CHARS ? fullText.slice(0, DIGEST_MAX_CHARS) : fullText;
  const userContent =
    `Filing: ${filing.ticker} ${filing.filingType} ${filing.filingDate || ""} ` +
    `(accession ${filing.accessionNumber})\n\nFiling text:\n` +
    `${wrapUntrustedFiling(body, `${filing.ticker} ${filing.filingType}`)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIGEST_TIMEOUT_MS);
  try {
    const stream = getAnthropicClient().messages.stream(
      {
        model: DIGEST_MODEL,
        max_tokens: 8000,
        output_config: { format: { type: "json_schema", schema: DIGEST_SCHEMA } },
        system: [{ type: "text", text: DIGEST_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }],
      },
      { signal: controller.signal },
    );
    const message = await stream.finalMessage();
    const parsed = JSON.parse(extractModelText(message, "Filing digest")) as Partial<FilingDigest>;
    const digest: FilingDigest = {
      overview: parsed.overview || "",
      sections: Array.isArray(parsed.sections) ? parsed.sections : [],
      keyFigures: Array.isArray(parsed.keyFigures) ? parsed.keyFigures : [],
      notableItems: Array.isArray(parsed.notableItems) ? parsed.notableItems : [],
      coverage: parsed.coverage || "",
    };
    const u = message.usage;
    return {
      digest,
      usage: { inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 },
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseFilingDigest(raw: string | null | undefined): FilingDigest | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<FilingDigest>;
    if (!d || typeof d.overview !== "string") return null;
    return {
      overview: d.overview || "",
      sections: Array.isArray(d.sections) ? d.sections : [],
      keyFigures: Array.isArray(d.keyFigures) ? d.keyFigures : [],
      notableItems: Array.isArray(d.notableItems) ? d.notableItems : [],
      coverage: d.coverage || "",
    };
  } catch {
    return null;
  }
}

// Render a stored digest into a readable block for the chat system prompt.
export function renderDigestBlock(digest: FilingDigest): string {
  const lines: string[] = [];
  lines.push(`OVERVIEW: ${digest.overview}`);
  if (digest.sections.length) {
    lines.push("\nSECTIONS:");
    for (const s of digest.sections) lines.push(`- ${s.name}: ${s.summary}`);
  }
  if (digest.keyFigures.length) {
    lines.push("\nKEY FIGURES:");
    for (const f of digest.keyFigures) lines.push(`- ${f.label}: ${f.value} (${f.context})`);
  }
  if (digest.notableItems.length) {
    lines.push("\nNOTABLE ITEMS:");
    for (const n of digest.notableItems) lines.push(`- [${n.category}] ${n.detail}`);
  }
  if (digest.coverage) lines.push(`\nCOVERAGE NOTE: ${digest.coverage}`);
  return lines.join("\n");
}

// In-process guard so two concurrent first-chats on the same filing don't both
// pay to generate the digest.
const inFlight = new Set<string>();

// Generate + persist the digest if one doesn't already exist. Best-effort and
// never throws: callers fire this in the background after answering from full
// text, so the NEXT session can answer from the cheap cached digest.
export async function ensureFilingDigest(accession: string): Promise<void> {
  if (inFlight.has(accession)) return;
  try {
    if (await storage.getFilingDigest(accession)) return;
    const filing = await storage.getFilingByAccession(accession);
    if (!filing || filing.status !== "complete") return;
    const pdfPath = resolvePdfPath(filing);
    if (!pdfPath) return;
    inFlight.add(accession);
    const text = await extractPdfText(pdfPath);
    if (!text.trim()) return;
    const { digest, usage } = await generateFilingDigest(filing, text);
    await storage.setFilingDigest(accession, JSON.stringify(digest));
    const cost =
      (usage.inputTokens * DIGEST_PRICE_INPUT + usage.outputTokens * DIGEST_PRICE_OUTPUT) / 1_000_000;
    console.log(`[digest] ${accession}: generated (~$${cost.toFixed(4)})`);
  } catch (err: any) {
    console.error(`[digest] ${accession}: generation failed:`, err?.message || err);
  } finally {
    inFlight.delete(accession);
  }
}
