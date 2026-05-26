import { storage } from "./storage";
import { getAnthropicClient, MODEL } from "./review";
import type { Filing } from "@shared/schema";

// Hard ceiling on the corpus we send to Claude so a runaway corpus can't blow
// the context window or cost. ~800k chars ≈ 200k tokens, well within the 1M
// context budget, leaving plenty of room for chat history + thinking + output.
const MAX_CORPUS_CHARS = 800_000;

// Bound any single chat request — same rationale as the review timeout.
const CHAT_TIMEOUT_MS = 3 * 60 * 1000;

const SYSTEM_PROMPT = `You are a research assistant for footnoted.com, helping editors and analysts query the database of post-worthy SEC filing findings.

Each finding has metadata (ticker, form type, filing date, accession) plus a headline, a detail (with quoted/paraphrased language and dollar figures from the filing), and a why-it-matters note. Findings are categorized as perks_comp, severance_parachute, related_party_insider, language_governance_accounting, or other.

Rules:
- Answer the user's question based ONLY on the findings corpus below. Do not invent companies, numbers, or filings.
- Cite every fact with [TICKER form date], e.g. [CAT DEF 14A 2026-04-30]. When multiple filings support a point, cite all of them.
- Quote concrete numbers and language from the findings when relevant — the editors want specifics, not summaries of summaries.
- When listing several companies, group cleanly (one per company or one per finding) and order from most striking/concrete to least.
- If a question cannot be answered from the corpus, say so plainly and suggest what the user could fetch or look up. Do not bluff.
- Tone: editorial and concise, like a footnoted.com reporter briefing another reporter. Not bureaucratic.`;

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

// Build the corpus once per request — small dataset for now (1-2k findings),
// fast to assemble and we want the freshest data. If/when this grows, swap for
// a pre-built cached blob.
async function buildFindingsCorpus(): Promise<{
  text: string;
  findingsCount: number;
  filingsCount: number;
  truncated: boolean;
}> {
  // Already sorted by filingDate desc.
  const filings: Filing[] = await storage.getFilings({ status: "complete" });
  const entries: string[] = [];
  let totalLen = 0;
  let truncated = false;
  let findingsCount = 0;
  let filingsCount = 0;
  for (const f of filings) {
    if (f.reviewStatus !== "done") continue;
    const findings = parseFindingsField(f.reviewFindings);
    if (findings.length === 0) continue;
    let includedFromThisFiling = 0;
    for (const fn of findings) {
      const block =
        `<finding ticker="${f.ticker}" form="${f.filingType}" date="${f.filingDate || ""}" ` +
        `accession="${f.accessionNumber}" category="${fn.category}" interest="${f.reviewMateriality || ""}">` +
        `\nHEADLINE: ${fn.headline}` +
        `\nDETAIL: ${fn.detail}` +
        (fn.why ? `\nWHY: ${fn.why}` : "") +
        `\n</finding>`;
      if (totalLen + block.length > MAX_CORPUS_CHARS) {
        truncated = true;
        break;
      }
      entries.push(block);
      totalLen += block.length;
      findingsCount += 1;
      includedFromThisFiling += 1;
    }
    if (includedFromThisFiling > 0) filingsCount += 1;
    if (truncated) break;
  }
  return { text: entries.join("\n\n"), findingsCount, filingsCount, truncated };
}

export async function chatAboutFindings(history: Turn[]): Promise<ChatResult> {
  const last = history[history.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    throw new Error("Last message must be a non-empty user message");
  }
  const corpus = await buildFindingsCorpus();
  if (corpus.findingsCount === 0) {
    throw new Error(
      "No reviewed findings in the database yet. Run a fetch & review first.",
    );
  }

  const corpusBlock =
    `Findings corpus (${corpus.findingsCount} findings across ${corpus.filingsCount} filings` +
    (corpus.truncated ? ", truncated to most recent — older filings may be omitted" : "") +
    `):\n\n${corpus.text}`;

  // 5-min timeout (the chat's max_tokens is small; this is generous).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const message = await getAnthropicClient().messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        system: [
          { type: "text", text: SYSTEM_PROMPT },
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
