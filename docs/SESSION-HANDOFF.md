# Session Handoff — SEC Filing App

> Purpose: let a **fresh Claude Code chat with zero prior context** pick up
> where the previous long session left off. Read this top to bottom first.
> Last updated at main `e664d18` (PR #94 merged).

---

## 1. What this app is

A SEC EDGAR filing ingestion + AI-review pipeline with a React/Express UI.
Two pieces:

- **`sec-filing-ui/`** — React (Vite) client + Express + PostgreSQL (Drizzle) server.
  All Claude/LLM calls live in `sec-filing-ui/server/`.
- **`sec-pdf-pipeline/`** — Python SEC fetch + Playwright HTML→PDF renderer.

Core flow: poll EDGAR → fetch filing HTML (httpx, documented UA) → preprocess
(strip XBRL, inline images as base64) → render to PDF via headless Chromium →
store PDF + DB row → optional Claude "editorial review" producing materiality
findings → surfaced in the **Findings** tab. Also: MD&A digests, S-1/S-1A
compares, and natural-language "Ask" chat over the findings corpus or a single
filing.

---

## 2. Environment & workflow facts (important gotchas)

- **Deploy:** Railway. The user deploys manually by telling Railway which commit
  to ship. There is no auto-deploy from `main` — after merging, tell the user
  it's ready and they trigger the deploy. Watch container logs via `[inf]`/`[err]`
  prefixes; render logs stream from the Python pipeline.
- **GitHub MCP flaps.** The `mcp__github__*` tools (and the Daloopa MCP) drop and
  reconnect repeatedly. When `ToolSearch` returns "no match" for a github tool,
  it's mid-disconnect — retry after the next reconnect notice. Nothing is broken;
  it self-heals. Do NOT try to "reinstall" it.
- **`node_modules` can reset mid-session.** If `npm run check` suddenly fails with
  `Cannot find type definition file for 'node'` / `vite/client`, run
  `npm install` in `sec-filing-ui/` and retry — it's an env reset, not a code bug.
- **Pre-existing build warnings (ignore):** `npm run build` always emits two
  `import.meta` cjs warnings at `routes.ts:42` and `review.ts:10`. Unrelated to
  any change; not worth fixing unless asked (would require flipping server output
  to ESM).
- **Branch convention:** feature branch → PR → squash-merge to `main`. Don't push
  to `main` directly. Create PRs only when the user asks (they have been asking).
  Commit-message trailer + PR-body trailer conventions are enforced by the harness.
- **Model:** the whole app uses one shared `MODEL` constant in
  `sec-filing-ui/server/review.ts` — currently `claude-opus-4-8`. Opus 4.7 and
  4.8 are priced identically, so the `PRICE_*` constants there are correct.
- **Checks before every PR:** `cd sec-filing-ui && npm run check && npm run build`,
  plus `python3 -m py_compile` on any touched Python file.

---

## 3. Everything shipped this session (all merged to `main`)

| PR | What |
|----|------|
| #82 | Block external resource loading in `render_html_to_pdf` |
| #83 | Wall-clock timeout around `render_html_to_pdf` (12 min) so a wedged Chromium can't hang the worker silently |
| #84 | `/api/registration/render` surfaces underlying render errors (treatPartialAsFailure flag) |
| #85 | S-1/S-1A render robustness: `page.set_content` → temp file + `page.goto(file://)`; bounded `page.close`; await persistence before reporting success; sanitize `S-1/A` → `S-1_A` in paths/filenames |
| #86 | Cache compare results in a `filing_compares` table (migration #3) so users don't pay twice; `refresh:true` + cache invalidation on re-render |
| #87 | First-class date-range picker (`DateRangeInput`) on Fetch & Review |
| #88 | "View in Findings" links carry `?ticker=` |
| #89 | Renderer route allowlist pinned to the exact temp file URL (was `file:` blanket) |
| #90 | `/api/filings/fetch` reports app-available PDF count (not Python pipeline count) |
| #91 | Fix #88: read `?ticker=` from `window.location.search` (wouter v3 puts the query there, not in the hash) |
| #92 | Filing-date lookback filter on Findings (reuses `DateRangeInput`) |
| #93 | Bump `MODEL` Opus 4.7 → 4.8 |
| #94 | **Prompt-injection Sprint 1** (see §5) |

Closed without merging: **#75** (registration HTML compare — superseded by #77's
PDF compare; its `treatPartialAsFailure` hardening was cherry-picked as #84).

---

## 4. Current state of the prompt-injection hardening project

The user asked for a full prompt-injection threat model and a multi-sprint plan.
The key framing finding: **Claude has no tools and no write access in this app** —
every call is pure text→text. So blast radius is bounded to *content quality*
(suppressed/fabricated findings) and *stored-corpus integrity*, NOT data
exfiltration or unauthorized actions. Defenses are proportioned accordingly;
heavyweight external guards (Lakera, NeMo, Prompt Shields) were deliberately
ruled out as overkill for a read-only-public-docs app with no tool surface.

### The six Claude call sites (the whole attack surface)
| Call site | Input trust | Output |
|---|---|---|
| `review.ts` editorial review | EXTERNAL filing text | JSON schema → DB (findings) |
| `mdna.ts` MD&A digest | EXTERNAL MD&A text | JSON schema → DB |
| `compare.ts` section compare | EXTERNAL × 2 | JSON schema → DB cache |
| `compare.ts` whole-filing registration compare | EXTERNAL × 2 | JSON schema → DB cache |
| `chat.ts` `chatAboutFindings` | CLAUDE-generated corpus + USER question | free text + citations |
| `chat.ts` `chatAboutFiling` | EXTERNAL filing text + USER question | free text |

### Top threats identified (ranked)
1. **S1 (HIGH)** — filer embeds a directive in filing text → suppressed finding.
2. **S2 (HIGH)** — injection survives review, persists into `reviewFindings`, then
   re-activates every time `chatAboutFindings` rebuilds the corpus. ("persistence
   laundering")
3. **S3 (MED)** — cross-document confusion in compares (LATER doc claims things
   about EARLIER).
4. **S4 (MED)** — filing-chat boundary breach.
5. **S5 (LOW-MED)** — fabricated `[TICKER FORM DATE]` citations rendered as links.
6. **S6/S7 (LOW)** — cost amplification (bounded by $600 cap + per-filing caps);
   refusal-mode silent breakage.

---

## 5. Sprint 1 (DONE — PR #94, merged `e664d18`)

New `sec-filing-ui/server/prompt-safety.ts`:
- `UNTRUSTED_CONTENT_GUIDANCE` — system-prompt clause: tagged content is data,
  embedded directives must be reported as findings not obeyed.
- `wrapUntrustedFiling(content, label?)` — wraps issuer text in
  `<untrusted_filing_content>` tags; defangs forged boundary tags (zero-width
  space after `<`).
- `extractModelText(message, context)` — central response parse; turns
  `stop_reason: "refusal"` into a thrown error instead of silent `""`.

Wired into all six call sites. Output caps left as-is (already sane: chat 4000,
structured 8000).

**Watch in production:** refusal-rate spikes (could be adversarial filers OR
false positives on benign disclosure language); reviews spuriously claiming "the
filing attempted to direct the reviewer…" when it didn't (means guidance is too
eager — dial back). User merged #94 specifically to test these in prod.

---

## 6. NEXT STEPS — Sprint 2 and Sprint 3 (NOT yet built)

### Sprint 2 — "Sanitize the corpus, ground the compares" (~3-4 days)
Addresses S2 (persistence laundering) and S3 (cross-doc confusion).
1. **Corpus tagging:** in `chat.ts` `buildFindingsCorpus` / where the corpus
   string is assembled for `chatAboutFindings`, wrap each stored finding's
   `detail`/`headline` in `<stored_finding accession="…">…</stored_finding>` so
   residual injection in a persisted finding is treated as untrusted at chat time.
2. **Evidence grounding on compares:** add `evidence_from_earlier: string` and
   `evidence_from_later: string` to the compare JSON schema (`COMPARE_SCHEMA` in
   `compare.ts`), require Claude to quote actual source text per `changed` entry,
   then post-hoc string-match those quotes back into the input — drop/flag
   entries whose "evidence" doesn't appear in the source.
3. Migration to invalidate cached compares (the `filing_compares` table from #86)
   so they regenerate under the new schema.

### Sprint 3 — "Verifier pass on reviews" (~3-5 days)
Addresses S1/S2 structurally with a second model.
1. Add a **Haiku 4.5** (`claude-haiku-4-5`, $1/$5 per 1M) verification call in the
   review pipeline: given a finding + the source excerpt, answer "is this finding
   faithfully derived from the source?" Drop unverified findings before persisting.
   Cost is ~$0.005-0.025/filing — cheap. Could alternatively use the Advisor tool
   (beta) but a separate Haiku call is simpler and provider-agnostic.
2. New DB columns `reviewVerified: boolean`, `verifierExplanation: text`
   (Drizzle schema + migration #4).
3. Drop unverified findings from the `chatAboutFindings` corpus.

### Operational follow-ups (not PRs)
- Stand up a **Promptfoo** regression suite (~20 injection payloads a hostile
  filer might try); run before every model bump.
- Quarterly review of refusal rates per filing type.
- Re-do the whole threat model the moment the app gives Claude ANY tool — tools
  change the blast radius from "content quality" to "actions," which is a
  completely different security posture.

---

## 7. How to resume in a new chat

1. Read this file.
2. `git checkout main && git pull` — confirm HEAD is at or past `e664d18`.
3. Ask the user what they observed from the Sprint 1 deploy (refusal rate, any
   false-positive injection callouts) before starting Sprint 2.
4. When building Sprint 2/3, follow the workflow in §2: feature branch → checks →
   PR → wait for the user to say "merge."
