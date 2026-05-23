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

const MODEL = "claude-opus-4-7";
// Cap the text sent per filing to bound cost/latency on very large 10-Ks.
const MAX_CHARS = 400_000;

export function isReviewEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

const SYSTEM_PROMPT = `You are a securities-disclosure analyst reviewing a single SEC filing for an investor. Your job is to decide whether the filing contains a MATERIAL DISCLOSURE — information a reasonable investor would consider important to an investment or voting decision, or that would significantly alter the total mix of available information.

Treat the following as material when present and substantive (not boilerplate or hypothetical risk-factor language):
- Mergers, acquisitions, divestitures, or major asset sales
- Bankruptcy, going-concern doubt, or covenant defaults
- Material litigation, regulatory actions, investigations, or settlements
- Financial restatements, material weaknesses in internal controls, or auditor changes/disagreements
- Earnings or guidance changes, material impairments or write-downs, or large unexpected charges
- Executive or board changes (CEO/CFO/Chair departures or appointments)
- Material debt issuance/refinancing, equity offerings, dividend changes, or buybacks
- Major customer/contract wins or losses, supply disruptions, or cybersecurity incidents/breaches
- Delisting notices or other significant corporate events

Do NOT flag generic, forward-looking, or hypothetical risk-factor boilerplate, routine recurring disclosures, or immaterial administrative items.

Judge materiality conservatively and specifically: cite the concrete event(s) in the filing, not generic categories. If the extracted text is empty or unreadable, return flagged=false, materiality="none", and say so in the summary.

Respond ONLY with the structured JSON the schema requires:
- flagged: true only if at least one material disclosure is present
- materiality: overall significance ("high", "medium", "low", or "none")
- summary: 1-4 sentences. If flagged, explain specifically what the material disclosure is and why it matters. If not flagged, briefly state that nothing material was found.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    flagged: { type: "boolean", description: "True if the filing contains a material disclosure" },
    materiality: { type: "string", enum: ["high", "medium", "low", "none"] },
    summary: { type: "string", description: "Why it was or wasn't flagged (1-4 sentences)" },
  },
  required: ["flagged", "materiality", "summary"],
  additionalProperties: false,
};

function resolvePdfPath(filing: Filing): string | null {
  if (!filing.pdfPath) return null;
  const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
  const pipelinePath = path.join(PIPELINE_ROOT, filing.pdfPath);
  return fs.existsSync(appPath) ? appPath : fs.existsSync(pipelinePath) ? pipelinePath : null;
}

async function extractPdfText(absPath: string): Promise<string> {
  const buffer = fs.readFileSync(absPath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

type ReviewResult = { flagged: boolean; materiality: string; summary: string };

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
  const parsed = JSON.parse(textBlock.text) as ReviewResult;
  return {
    flagged: !!parsed.flagged,
    materiality: parsed.materiality || "none",
    summary: parsed.summary || "",
  };
}

async function reviewOne(filing: Filing): Promise<void> {
  await storage.setFilingReviewStatus(filing.accessionNumber, "reviewing");
  try {
    const pdfPath = resolvePdfPath(filing);
    if (!pdfPath) throw new Error("Rendered PDF not found on disk");
    const text = await extractPdfText(pdfPath);
    const result = await callClaude(filing, text);
    await storage.setFilingReviewResult(filing.accessionNumber, result);
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

// Drain all pending filings sequentially. Safe to call repeatedly; only one
// drain runs at a time per process. No-op when no API key is configured.
export async function kickReviewProcessor(): Promise<void> {
  if (!isReviewEnabled() || processing) return;
  processing = true;
  try {
    while (true) {
      const batch = await storage.getPendingReviewFilings(5);
      if (batch.length === 0) break;
      for (const filing of batch) {
        await reviewOne(filing);
      }
    }
  } catch (err) {
    console.error("[review] Processor error:", err);
  } finally {
    processing = false;
  }
}
