import { storage } from "./storage";
import { getAnthropicClient, MODEL, resolvePdfPath, extractPdfText } from "./review";
import { getSecTickerIndex } from "./sec-index";
import type { Filing } from "@shared/schema";

// Ticker → official company name, projected from the shared SEC index. Used
// for entity detection (e.g. "Thermo Fisher" → TMO) so we can scope the chat
// to a few filings instead of the whole corpus.
async function getTickerNameIndex(): Promise<Map<string, string>> {
  const idx = await getSecTickerIndex();
  const map = new Map<string, string>();
  Array.from(idx.entries()).forEach(([ticker, entry]) => {
    if (entry.name) map.set(ticker, entry.name);
  });
  return map;
}

// Tokens to drop from company names so a match doesn't require "Inc."/"Corp."
const NAME_SUFFIXES = new Set([
  "INC", "INC.", "CORP", "CORP.", "CORPORATION", "CO", "CO.", "COMPANY",
  "LLC", "LTD", "LTD.", "PLC", "HOLDINGS", "GROUP", "TRUST", "FUND",
  "CLASS", "COMMON", "NEW", "&", "THE", "L.P.", "LP",
]);

function nameTokens(rawName: string): string[] {
  return rawName
    .toUpperCase()
    .split(/[\s,.()]+/)
    .filter((t) => t && !NAME_SUFFIXES.has(t));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Detect which tickers in the corpus the user is asking about. Returns a Set
// of matched tickers, or an empty Set if no entity is mentioned (caller falls
// back to the full corpus). Conservative — single-word matches require >= 6
// characters and a word boundary, to avoid false positives on common English
// words.
function detectScopedTickers(
  question: string,
  corpusTickers: Set<string>,
  tickerToName: Map<string, string>,
): Set<string> {
  const matched = new Set<string>();
  // 1) Exact ticker symbol mentions (uppercase tokens in the question).
  const tokenRe = /\b[A-Z]{1,5}(?:[.\-][A-Z]{1,2})?\b/g;
  const tickMatches = Array.from(question.match(tokenRe) ?? []);
  for (const tok of tickMatches) {
    if (corpusTickers.has(tok)) matched.add(tok);
  }
  // 2) Company-name mentions. Try increasingly specific match patterns per
  //    ticker so e.g. "Thermo Fisher" matches "Thermo Fisher Scientific Inc.".
  const lower = question.toLowerCase();
  for (const ticker of Array.from(corpusTickers)) {
    if (matched.has(ticker)) continue;
    const name = tickerToName.get(ticker);
    if (!name) continue;
    const tokens = nameTokens(name);
    if (tokens.length === 0) continue;
    let hit = false;
    // 2a) Full normalized name as a substring.
    const full = tokens.join(" ").toLowerCase();
    if (full.length >= 5 && lower.includes(full)) hit = true;
    // 2b) Two-word prefix (covers "Thermo Fisher" → TMO).
    if (!hit && tokens.length >= 2) {
      const two = (tokens[0] + " " + tokens[1]).toLowerCase();
      if (two.length >= 5 && lower.includes(two)) hit = true;
    }
    // 2c) A single distinctive first word, ≥6 chars, on a word boundary.
    if (!hit && tokens[0].length >= 6) {
      const re = new RegExp(`\\b${escapeRegExp(tokens[0].toLowerCase())}\\b`);
      if (re.test(lower)) hit = true;
    }
    if (hit) matched.add(ticker);
  }
  return matched;
}

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

Each \`<filing>\` block contains metadata (ticker, form, date, accession), an editorial SUMMARY of the filing, and zero or more discrete <finding> entries with a HEADLINE, DETAIL, and WHY note.

Field provenance — this matters:
- DETAIL (and any quoted language/numbers in it) and HEADLINE summarize or quote what the FILING ITSELF says. These are the company's own words/disclosures.
- SUMMARY and WHY are footnoted's own editorial gloss — our interpretation of why a finding is post-worthy. They are NOT statements made by the company and NOT facts asserted by the filing.

Rules:
- Answer the user's question based ONLY on the corpus below. Do not invent companies, numbers, filings, or facts.
- Never present a SUMMARY or WHY note as something the company said or as a fact from the filing. If you draw on a WHY note, attribute it as footnoted's read (e.g. "footnoted flags this because…"), not as the company's statement.
- Do NOT invent causation. Only say something is "due to" / "driven by" / "tied to" / "because of" a cause if a DETAIL explicitly states that causal link. If the corpus only states two facts side by side, do not connect them.
- Do NOT connect a finding to external events — tariffs, geopolitics, conflicts, oil/commodity prices, interest rates, macro conditions — unless a DETAIL explicitly makes that connection. The user's question framing (e.g. asking "about tariffs") does NOT license you to file a company under that theme.
- Do NOT group a company under a theme unless its DETAIL supports it. If the corpus doesn't establish a connection the user is asking about, say so plainly rather than inferring one.
- Cite every fact with [TICKER form date], e.g. [CAT DEF 14A 2026-04-30]. When multiple filings support a point, cite all of them.
- Quote concrete numbers and language from the corpus when relevant — editors want specifics.
- When listing several companies, group cleanly and order from most striking to least.
- If something isn't in the corpus, say so plainly. Important: the corpus is intentionally focused on buried, post-worthy details (perks, severance, related-party, governance/accounting tells). Routine operational/financial content (e.g. price escalators, revenue mix, segment results) often won't be a finding — if asked about that, point the user to the "Ask this filing" deep-dive on the relevant filing.
- Tone: editorial and concise, like a footnoted.com reporter briefing another reporter. Concise does not mean confident — when the corpus is thin or silent on something, say so rather than filling the gap.`;

const FILING_SYSTEM_PROMPT = `You are a research assistant analyzing a single SEC filing for a footnoted.com editor.

Answer questions based ONLY on the filing text below. Quote concrete language and numbers from the filing whenever they support an answer. If something isn't in the filing, say so plainly — don't make things up. Be editorial and concise.`;

type Turn = { role: "user" | "assistant"; content: string };

export type Citation = {
  ticker: string;
  form: string;
  date: string | null;
  accession: string;
};

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
  // Tickers the question was auto-scoped to (empty when the question was
  // general and the full corpus was sent).
  scopedTickers: string[];
  // Filings included in the corpus this turn — the client uses this to turn
  // [TICKER FORM DATE] citations in the answer into clickable links.
  citations: Citation[];
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
async function buildFindingsCorpus(scopedTickers?: Set<string>): Promise<{
  text: string;
  findingsCount: number;
  filingsCount: number;
  truncated: boolean;
  citations: Citation[];
}> {
  // Already sorted by filingDate desc.
  const filings: Filing[] = await storage.getFilings({ status: "complete" });
  const blocks: string[] = [];
  const citations: Citation[] = [];
  let totalLen = 0;
  let truncated = false;
  let findingsCount = 0;
  let filingsCount = 0;
  for (const f of filings) {
    if (f.reviewStatus !== "done") continue;
    if (scopedTickers && scopedTickers.size > 0 && !scopedTickers.has(f.ticker)) continue;
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
    citations.push({
      ticker: f.ticker,
      form: f.filingType,
      date: f.filingDate,
      accession: f.accessionNumber,
    });
    totalLen += filingBlock.length;
    findingsCount += findings.length;
    filingsCount += 1;
  }
  return { text: blocks.join("\n\n"), findingsCount, filingsCount, truncated, citations };
}

export async function chatAboutFindings(history: Turn[]): Promise<ChatResult> {
  const last = history[history.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    throw new Error("Last message must be a non-empty user message");
  }

  // Entity scoping: try to detect which tickers the question is about and
  // filter the corpus to just those filings. Falls back to the full corpus
  // when no entity is detected. A scoped query against ~5 filings is ~50x
  // cheaper than caching the whole library.
  const allFilings = await storage.getFilings({ status: "complete" });
  const corpusTickers = new Set<string>();
  for (const f of allFilings) {
    if (f.reviewStatus === "done") corpusTickers.add(f.ticker);
  }
  let scope: Set<string> = new Set();
  try {
    const nameIndex = await getTickerNameIndex();
    scope = detectScopedTickers(last.content, corpusTickers, nameIndex);
  } catch {
    // If the SEC index fails to load, fall back to ticker-symbol-only detection
    // (still useful for queries like "what did TMO say…").
    scope = detectScopedTickers(last.content, corpusTickers, new Map());
  }

  let corpus = await buildFindingsCorpus(scope.size > 0 ? scope : undefined);
  // If a scope was detected but yielded nothing (e.g. the user mentioned an
  // entity we don't have reviews for), drop back to the full corpus rather
  // than refusing to answer.
  if (scope.size > 0 && corpus.findingsCount === 0 && corpus.filingsCount === 0) {
    scope = new Set();
    corpus = await buildFindingsCorpus();
  }
  if (corpus.findingsCount === 0 && corpus.filingsCount === 0) {
    throw new Error(
      "No reviewed findings in the database yet. Run a fetch & review first.",
    );
  }

  const scopeLabel =
    scope.size > 0 ? ` scoped to ${Array.from(scope).sort().join(", ")}` : "";
  const corpusBlock =
    `Findings corpus (${corpus.findingsCount} findings across ${corpus.filingsCount} filings${scopeLabel}` +
    (corpus.truncated ? ", truncated to most recent — older filings may be omitted" : "") +
    `):\n\n${corpus.text}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    const message = await getAnthropicClient().messages.create(
      {
        model: MODEL,
        max_tokens: 4000,
        temperature: 0,
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
      scopedTickers: Array.from(scope).sort(),
      citations: corpus.citations,
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
        temperature: 0,
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
      scopedTickers: [filing.ticker],
      citations: [
        {
          ticker: filing.ticker,
          form: filing.filingType,
          date: filing.filingDate,
          accession: filing.accessionNumber,
        },
      ],
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
