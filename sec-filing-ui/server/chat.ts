import { storage } from "./storage";
import { getAnthropicClient, MODEL, resolvePdfPath, extractPdfText } from "./review";
import type { Filing } from "@shared/schema";

// Larger cap now that we've validated the chat. ~1.6M chars ≈ ~400k tokens —
// fits the full corpus today and still leaves ~600k headroom in the 1M context
// for chat history, thinking, and the answer.
const MAX_CORPUS_CHARS = 1_600_000;

// Cap a single filing's text the same way the review does (avoid runaway
// context on giant 10-Ks).
const MAX_FILING_CHARS = 400_000;

// Bound any single chat request — same rationale as the review timeout.
const CHAT_TIMEOUT_MS = 3 * 60 * 1000;

const CORPUS_SYSTEM_PROMPT = `You are a research assistant for footnoted.com, helping editors and analysts query the database of post-worthy SEC filing findings.

Each \`<filing>\` block contains metadata (ticker, form, date, accession), an editorial SUMMARY of the filing, and zero or more discrete <finding> entries with a headline, detail, and why-it-matters note.

Rules:
- Answer the user's question based ONLY on the corpus below. Do not invent companies, numbers, or filings.
- Cite every fact with [TICKER form date], e.g. [CAT DEF 14A 2026-04-30]. When multiple filings support a point, cite all of them.
- Quote concrete numbers and language from the corpus when relevant — editors want specifics.
- When listing several companies, group cleanly and order from most striking to least.
- If something isn't in the corpus, say so plainly. Important: the corpus is intentionally focused on buried, post-worthy details (perks, severance, related-party, governance/accounting tells). Routine operational/financial content (e.g. price escalators, revenue mix, segment results) often won't be a finding — if asked about that, point the user to the "Ask this filing" deep-dive on the relevant filing.
- Tone: editorial and concise, like a footnoted.com reporter briefing another reporter.`;

const FILING_SYSTEM_PROMPT = `You are a research assistant analyzing a single SEC filing for a footnoted.com editor.

Answer questions based ONLY on the filing text below. Quote concrete language and numbers from the filing whenever they support an answer. If something isn't in the filing, say so plainly — don't make things up. Be editorial and concise.`;

type Turn = { role: "user" | "assistant"; content: string };

export type ChatResult = {
  answer: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  corpusFindingsCount: number;
  corpusFilingsCount: number;
  truncated: boolean;
};

export type FilingChatResult = ChatResult & {
  ticker: string;
  form: string;
  date: string | null;
};

function parseFindingsField(raw: string | null | undefined): Array<{
  category: string;
  headline: string;
  detail: string;
  why: string;
}> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as any[];
    return [];
  } catch {
    return [];
  }
}

// Build the corpus per request. One <filing> block per reviewed filing
// containing the editorial summary plus its discrete findings — gives the
// chat broader context than findings alone (without dragging in raw filing
// text).
async function buildFindingsCorpus(): Promise<{
  text: string;
  findingsCount: number;
  filingsCount: number;
  truncated: boolean;
}> {
  // Already sorted by filingDate desc.
  const filings: Filing[] = await storage.getFilings({ status: "complete" });
  const blocks: string[] = [];
  let totalLen = 0;
  let truncated = false;
  let findingsCount = 0;
  let filingsCount = 0;
  for (const f of filings) {
    if (f.reviewStatus !== "done") continue;
    const findings = parseFindingsField(f.reviewFindings);
    if (findings.length === 0 && !f.reviewSummary) continue;
    const findingBlocks = findings
      .map(
        (fn) =>
          `  <finding category="${fn.category}">` +
          `\n    HEADLINE: ${fn.headline}` +
          `\n    DETAIL: ${fn.detail}` +
          (fn.why ? `\n    WHY: ${fn.why}` : "") +
          `\n  </finding>`,
      )
      .join("\n");
    const filingBlock =
      `<filing ticker="${f.ticker}" form="${f.filingType}" date="${f.filingDate || ""}" ` +
      `accession="${f.accessionNumber}" interest="${f.reviewMateriality || ""}">` +
      (f.reviewSummary ? `\n  SUMMARY: ${f.reviewSummary}` : "") +
      (findingBlocks ? `\n${findingBlocks}` : "") +
      `\n</filing>`;
    if (totalLen + filingBlock.length > MAX_CORPUS_CHARS) {
      truncated = true;
      break;
    }
    blocks.push(filingBlock);
    totalLen += filingBlock.length;
    findingsCount += findings.length;
    filingsCount += 1;
  }
  return { text: blocks.join("\n\n"), findingsCount, filingsCount, truncated };
}

export async function chatAboutFindings(history: Turn[]): Promise<ChatResult> {
  const last = history[history.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    throw new Error("Last message must be a non-empty user message");
  }
  const corpus = await buildFindingsCorpus();
  if (corpus.findingsCount === 0 && corpus.filingsCount === 0) {
    throw new Error(
      "No reviewed findings in the database yet. Run a fetch & review first.",
    );
  }

  const corpusBlock =
    `Findings corpus (${corpus.findingsCount} findings across ${corpus.filingsCount} filings` +
    (corpus.truncated ? ", truncated to most recent — older filings may be omitted" : "") +
    `):\n\n${corpus.text}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const message = await getAnthropicClient().messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        system: [
          { type: "text", text: CORPUS_SYSTEM_PROMPT },
          // Cache the corpus block so follow-up questions are cheap.
          { type: "text", text: corpusBlock, cache_control: { type: "ephemeral" } },
        ],
        messages: history.map((t) => ({ role: t.role, content: t.content })),
      },
      { signal: controller.signal },
    );
    const textBlock = message.content.find((b) => b.type === "text");
    const answer = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const u = message.usage;
    return {
      answer,
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
      },
      corpusFindingsCount: corpus.findingsCount,
      corpusFilingsCount: corpus.filingsCount,
      truncated: corpus.truncated,
    };
  } catch (err: any) {
    if (controller.signal.aborted) {
      throw new Error(`Chat timed out after ${Math.round(CHAT_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Deep-dive: chat against the full text of a single filing. Used for questions
// the corpus chat can't answer (e.g. routine MD&A content like price
// escalators) — the filing's full PDF text is sent with cache_control so a
// follow-up turn in the same conversation is cheap.
export async function chatAboutFiling(
  accession: string,
  history: Turn[],
): Promise<FilingChatResult> {
  const last = history[history.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    throw new Error("Last message must be a non-empty user message");
  }
  const filing = await storage.getFilingByAccession(accession);
  if (!filing) throw new Error("Filing not found");
  if (filing.status !== "complete") {
    throw new Error("Filing isn't rendered yet — fetch and render it first.");
  }
  const pdfPath = resolvePdfPath(filing);
  if (!pdfPath) {
    throw new Error(
      "Rendered PDF is missing on disk (storage may have been cleared on a redeploy). Re-fetch this filing to regenerate it.",
    );
  }
  const fullText = await extractPdfText(pdfPath);
  if (!fullText.trim()) {
    throw new Error("Could not extract text from this filing's PDF.");
  }
  const truncated = fullText.length > MAX_FILING_CHARS;
  const body = truncated ? fullText.slice(0, MAX_FILING_CHARS) : fullText;
  const header =
    `Filing: ${filing.ticker} ${filing.filingType} ${filing.filingDate || ""} ` +
    `(accession ${filing.accessionNumber})` +
    (truncated ? `\n[NOTE: filing text truncated to the first ${MAX_FILING_CHARS} characters]` : "");

  const filingBlock = `${header}\n\nFiling text:\n${body}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const message = await getAnthropicClient().messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        system: [
          { type: "text", text: FILING_SYSTEM_PROMPT },
          { type: "text", text: filingBlock, cache_control: { type: "ephemeral" } },
        ],
        messages: history.map((t) => ({ role: t.role, content: t.content })),
      },
      { signal: controller.signal },
    );
    const textBlock = message.content.find((b) => b.type === "text");
    const answer = textBlock && textBlock.type === "text" ? textBlock.text : "";
    const u = message.usage;
    return {
      answer,
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
      },
      corpusFindingsCount: 0,
      corpusFilingsCount: 1,
      truncated,
      ticker: filing.ticker,
      form: filing.filingType,
      date: filing.filingDate,
    };
  } catch (err: any) {
    if (controller.signal.aborted) {
      throw new Error(`Chat timed out after ${Math.round(CHAT_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
