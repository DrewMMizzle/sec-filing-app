import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { PDFParse } from "pdf-parse";
import { storage } from "./storage";
import type { Filing } from "@shared/schema";

// Works in both ESM (dev via tsx) and CJS (prod via esbuild)
const __filename_compat = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const __dirname_compat = path.dirname(__filename_compat);

// Resolve PDFs the same way routes.ts does, so review reads the same files.
const PDF_STORAGE_DIR = process.env.PDF_STORAGE_DIR || path.resolve(__dirname_compat, "..", "pdfs");
const PIPELINE_ROOT = process.env.PIPELINE_ROOT || path.resolve(__dirname_compat, "../../sec-pdf-pipeline");

export const MODEL = "claude-opus-4-7";
// Cap the text sent per filing to bound cost/latency on very large 10-Ks.
const MAX_CHARS = 400_000;

// Opus 4.7 pricing (USD per 1M tokens).
const PRICE_INPUT = 5;
const PRICE_OUTPUT = 25;
const PRICE_CACHE_READ = 0.5;
const PRICE_CACHE_WRITE = 6.25;

// Dollar cost of a set of token counts.
export function reviewCostUsd(u: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  return (
    (u.inputTokens * PRICE_INPUT +
      u.outputTokens * PRICE_OUTPUT +
      u.cacheReadTokens * PRICE_CACHE_READ +
      u.cacheCreationTokens * PRICE_CACHE_WRITE) /
    1_000_000
  );
}

export function isReviewEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client: Anthropic | null = null;
export function getAnthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}
function client(): Anthropic {
  return getAnthropicClient();
}

const SYSTEM_PROMPT = `You are an investigative editor for footnoted.com, a publication that digs through SEC filings to find the buried, easy-to-miss, often telling details that make a great story — the kind of thing most readers and even most analysts skim right past. You are NOT looking for the big, obvious headline event. You are looking for what's hiding in the footnotes, the exhibits, the compensation tables, and the lawyerly language.

Read the filing and surface DISCRETE, POST-WORTHY FINDINGS. Hunt hardest for:

- Executive perks & compensation oddities: personal use of corporate aircraft, security details, club memberships, tax gross-ups, relocation packages, large "all other compensation" lines, consulting deals for departing execs, unusual or outsized bonuses, repriced/backdated options, perks for family members.
- Severance & golden parachutes: large or quietly-enriched separation payments, change-in-control payouts, accelerated vesting, employment-agreement amendments, non-competes being waived, clawback provisions weakened or not enforced.
- Related-party & insider dealings: transactions with directors, officers, their family members or affiliated entities; insider loans; shares pledged as collateral or margined; leases/contracts with insiders; sweetheart arrangements.
- Language, governance & accounting tells: new or materially changed risk-factor language, defensive/"CYA" wording, auditor changes or disagreements, going-concern doubt, restatements, material weaknesses, changes in accounting treatment, unusual one-time charges, governance changes that entrench management.

What makes a good finding: it's specific, it's somewhat buried or non-obvious, and a sharp financial journalist would want to write a short post about it. A finding can be small if it's revealing. Quote or closely paraphrase the actual language/numbers and say where it appears (e.g. "in the Summary Compensation Table footnotes", "Exhibit 10.2", "Item 5").

Be selective and skeptical. Do NOT manufacture findings. Skip routine boilerplate, standard recurring disclosures, generic forward-looking risk language, and ordinary administrative items. It is completely fine — and common — to return zero findings for an unremarkable filing.

If the extracted text is empty or unreadable, return interesting=false, interestingness="none", an empty findings array, and say so in the summary.

Respond ONLY with the structured JSON the schema requires:
- interesting: true if there is at least one post-worthy finding
- interestingness: overall editorial interest of the filing ("high", "medium", "low", or "none")
- summary: 1-2 sentences giving the editor the lead — the single most post-worthy angle, or that nothing notable was found
- findings: an array (possibly empty) where each item has:
    - category: one of "perks_comp", "severance_parachute", "related_party_insider", "language_governance_accounting", "other"
    - headline: a punchy, specific draft headline/angle a writer could build a post from
    - detail: the concrete buried detail — quote or closely paraphrase the language/numbers and note where in the filing it appears
    - why: one sentence on why it's interesting or post-worthy`;

const FINDING_CATEGORIES = [
  "perks_comp",
  "severance_parachute",
  "related_party_insider",
  "language_governance_accounting",
  "other",
];

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    interesting: { type: "boolean", description: "True if there is at least one post-worthy finding" },
    interestingness: { type: "string", enum: ["high", "medium", "low", "none"] },
    summary: { type: "string", description: "1-2 sentence lead for the editor" },
    findings: {
      type: "array",
      description: "Discrete post-worthy findings (may be empty)",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: FINDING_CATEGORIES },
          headline: { type: "string", description: "Punchy draft headline/angle" },
          detail: { type: "string", description: "The buried detail, quoted/paraphrased, with location" },
          why: { type: "string", description: "Why it's post-worthy (one sentence)" },
        },
        required: ["category", "headline", "detail", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["interesting", "interestingness", "summary", "findings"],
  additionalProperties: false,
};

export function resolvePdfPath(filing: Filing): string | null {
  if (!filing.pdfPath) return null;
  const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
  const pipelinePath = path.join(PIPELINE_ROOT, filing.pdfPath);
  return fs.existsSync(appPath) ? appPath : fs.existsSync(pipelinePath) ? pipelinePath : null;
}

export async function extractPdfText(absPath: string): Promise<string> {
  const buffer = fs.readFileSync(absPath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

type Finding = { category: string; headline: string; detail: string; why: string };
type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
type ReviewResult = {
  interesting: boolean;
  interestingness: string;
  summary: string;
  findings: Finding[];
  usage: Usage;
};

async function callClaude(filing: Filing, text: string): Promise<ReviewResult> {
  const trimmed = text.length > MAX_CHARS;
  const body = trimmed ? text.slice(0, MAX_CHARS) : text;
  const userContent =
    `Filing metadata:\n` +
    `- Ticker: ${filing.ticker}\n` +
    `- Form type: ${filing.filingType}\n` +
    `- Filing date: ${filing.filingDate || "unknown"}\n` +
    `- Accession: ${filing.accessionNumber}\n\n` +
    (trimmed ? `[NOTE: filing text truncated to the first ${MAX_CHARS} characters]\n\n` : "") +
    (body.trim() ? `Filing text:\n${body}` : `Filing text: [no extractable text]`);

  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: REVIEW_SCHEMA },
    },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
  });

  const message = await stream.finalMessage();
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text block in Claude response");
  }
  const parsed = JSON.parse(textBlock.text) as Partial<ReviewResult>;
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const u = message.usage;
  return {
    interesting: !!parsed.interesting,
    interestingness: parsed.interestingness || (findings.length > 0 ? "low" : "none"),
    summary: parsed.summary || "",
    findings,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
    },
  };
}

async function reviewOne(filing: Filing): Promise<void> {
  await storage.setFilingReviewStatus(filing.accessionNumber, "reviewing");
  try {
    const pdfPath = resolvePdfPath(filing);
    if (!pdfPath)
      throw new Error(
        "Rendered PDF is missing on disk (storage may have been cleared on a redeploy). Re-fetch this filing to regenerate it.",
      );
    const text = await extractPdfText(pdfPath);
    const result = await callClaude(filing, text);
    await storage.setFilingReviewResult(filing.accessionNumber, result, result.usage);
  } catch (err: any) {
    console.error(`[review] Failed for ${filing.accessionNumber}:`, err?.message || err);
    await storage.setFilingReviewError(filing.accessionNumber, String(err?.message || err));
  }
}

// On startup, requeue any reviews stuck mid-flight from a crash, then drain.
export async function resumeReviews(): Promise<void> {
  if (!isReviewEnabled()) return;
  try {
    await storage.requeueStaleReviews();
  } catch (err) {
    console.error("[review] Failed to requeue stale reviews:", err);
  }
  kickReviewProcessor().catch((err) => console.error("[review] Resume drain failed:", err));
}

let processing = false;

// Drain pending filings sequentially. Safe to call repeatedly; only one drain
// runs at a time per process. No-op when no API key is configured. If a team
// spend cap is set, the drain stops (leaving filings 'pending') once cumulative
// review spend reaches the cap. The cap applies ONLY to this review processor —
// the Compare feature does not go through here and is never throttled.
export async function kickReviewProcessor(): Promise<void> {
  if (!isReviewEnabled() || processing) return;
  processing = true;
  try {
    while (true) {
      const budget = await storage.getReviewBudgetUsd();
      if (budget !== null && reviewCostUsd(await storage.getReviewUsage()) >= budget) {
        console.log(`[review] Spend cap of $${budget} reached — pausing review queue.`);
        break;
      }
      // Process one at a time so the cap is checked between every filing.
      const batch = await storage.getPendingReviewFilings(1);
      if (batch.length === 0) break;
      await reviewOne(batch[0]);
    }
  } catch (err) {
    console.error("[review] Processor error:", err);
  } finally {
    processing = false;
  }
}
