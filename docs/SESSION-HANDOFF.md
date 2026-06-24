# Session Handoff — SEC Filing App

> Purpose: let a **fresh Claude Code chat with zero prior context** pick up
> where the previous long session left off. Read this top to bottom first.
> Last updated at main `63e997d` (PR #98 merged — prompt-injection Sprints 1–3
> + Anthropic overload hardening all shipped).

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
  `import.meta` cjs warnings at `routes.ts:42` and `review.ts:11` (line numbers
  drift as files change). Unrelated to any change; not worth fixing unless asked
  (would require flipping server output to ESM).
- **Branch convention:** feature branch → PR → squash-merge to `main`. Don't push
  to `main` directly. Create PRs only when the user asks (they have been asking).
  Commit-message trailer + PR-body trailer conventions are enforced by the harness.
- **Model:** the whole app uses one shared `MODEL` constant in
  `sec-filing-ui/server/review.ts` — currently `claude-opus-4-8`. Opus 4.7 and
  4.8 are priced identically, so the `PRICE_*` constants there are correct. The
  Sprint 3 verifier uses a separate `VERIFIER_MODEL = "claude-haiku-4-5"`.
- **Anthropic transient overloads are handled (PR #97).** The shared client uses
  `maxRetries: 5`; `claudeHttpError()` maps `overloaded_error`/429/5xx to a clean
  503 ("temporarily overloaded — retry"). If a user reports an `overloaded_error`,
  it's a transient Anthropic capacity spike, not a bug — retry usually clears it.
- **Checks before every PR:** `cd sec-filing-ui && npm run check && npm run build`,
  plus `python3 -m py_compile` on any touched Python file.

---

## 3. Everything shipped (all merged to `main`)

Earlier this project (pre-handoff): **#82–#93** — Python render hardening (#82,
#83, #85), render-error surfacing (#84), compare cache + `filing_compares`
migration #3 (#86), date-range UI (#87, #92), `?ticker=` deep-links (#88, #91),
renderer route allowlist (#89), PDF-count fix (#90), `MODEL` Opus 4.7→4.8 (#93).
(#75 closed unmerged — superseded by #77's PDF compare; its hardening landed as
#84.)

Prompt-injection project + recent hardening:

| PR | Merged | What |
|----|--------|------|
| #94 | `e664d18` | **Prompt-injection Sprint 1** — `prompt-safety.ts` (see §5) |
| #95 | `bb6b81a` | This handoff doc |
| #96 | `22daeed` | **Prompt-injection Sprint 2** — corpus sanitization + compare evidence grounding (see §6) |
| #97 | `e081e38` | Anthropic overload retry hardening (`maxRetries: 5` + `claudeHttpError`) — see §2 |
| #98 | `63e997d` | **Prompt-injection Sprint 3** — Haiku faithfulness verifier on reviews (see §7) |

---

## 4. The prompt-injection threat model (framing)

The user asked for a full prompt-injection threat model and a multi-sprint plan.
Key framing finding: **Claude has no tools and no write access in this app** —
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

### Top threats + current status
1. **S1 (HIGH)** — filer embeds a directive in filing text. Two halves:
   - *Fabrication* (invent/steer a finding): **mitigated** by Sprint 3 verifier.
   - *Suppression* (omit a real finding): **STILL OPEN** — see §8. The verifier
     can't see a finding that was never produced.
2. **S2 (HIGH)** — injection survives review, persists into `reviewFindings`,
   re-activates when `chatAboutFindings` rebuilds the corpus ("persistence
   laundering"). **Mitigated:** Sprint 2 sanitizes the corpus + marks it
   untrusted; Sprint 3 drops fabricated findings before they persist.
3. **S3 (MED)** — cross-document confusion in compares. **Mitigated** by Sprint 2
   evidence grounding.
4. **S4 (MED)** — filing-chat boundary breach. **Mitigated** by Sprint 1
   (`chatAboutFiling` wraps filing text + `FILING_SYSTEM_PROMPT` guidance).
5. **S5 (LOW-MED)** — fabricated `[TICKER FORM DATE]` citations. Low risk: the
   client only links citations that match real corpus filings; fabricated ones
   just don't resolve. Not separately hardened.
6. **S6/S7 (LOW)** — cost amplification (bounded by spend cap + per-filing caps);
   refusal-mode silent breakage (**fixed** by Sprint 1 `extractModelText`).

---

## 5. Sprint 1 (DONE — PR #94)

New `sec-filing-ui/server/prompt-safety.ts`:
- `UNTRUSTED_CONTENT_GUIDANCE` — system-prompt clause: tagged content is data,
  embedded directives must be reported as findings not obeyed.
- `wrapUntrustedFiling(content, label?)` — wraps issuer text in
  `<untrusted_filing_content>` tags; defangs forged boundary tags (zero-width
  space after `<`).
- `extractModelText(message, context)` — central response parse; turns
  `stop_reason: "refusal"` into a thrown error instead of silent `""`.

Wired into all six call sites. **Observed good in prod** (user confirmed: no
refusal-rate spike, no spurious "the filing attempted to direct the reviewer…").

---

## 6. Sprint 2 (DONE — PR #96)

"Sanitize the corpus, ground the compares." Addresses S2 + S3.

- **Corpus sanitization (S2)** in `prompt-safety.ts` + `chat.ts`:
  - Generalized the tag-defang logic into `defangTags(content, tags)`; both
    `wrapUntrustedFiling` and the new `sanitizeStoredField()` use it.
  - `sanitizeStoredField()` defangs forged `<filing>`/`<finding>`/
    `<untrusted_filing_content>` tags inside stored finding fields so a persisted
    finding can't break out of its corpus block. Applied to summary/headline/
    detail/why (+ category) in `buildFindingsCorpus`.
  - `STORED_CORPUS_GUIDANCE` appended to `CORPUS_SYSTEM_PROMPT` — marks the whole
    findings corpus as untrusted data.
- **Compare evidence grounding (S3)** in `compare.ts`:
  - `CHANGE_ITEM_SCHEMA` now requires `evidence_from_earlier` / `evidence_from_later`
    (verbatim quotes). `EVIDENCE_GROUNDING_GUIDANCE` tells the model which side to
    quote per added/removed/changed.
  - `groundChangelog()` string-matches each quote against the **exact text the
    model saw** (the *sampled* text for registration compares) via
    `quoteAppearsInSource()` (whitespace-normalized, lowercased, ≥12 chars), and
    **drops** ungrounded entries, appending `[N reported changes were omitted…]`
    to the summary. Evidence fields are stripped before persisting → cached
    `CompareResult` shape + client unchanged.
- **Migration #4** (`invalidate_compares_for_evidence_grounding`) clears the
  `filing_compares` cache so pre-Sprint-2 results regenerate under the new schema.

**Watch in prod:** the `[N reported changes were omitted…]` note. If legitimate
changes get dropped (model paraphrasing instead of quoting verbatim), loosen the
matcher — lower the 12-char floor in `quoteAppearsInSource`, or relax `changed`
to require one side instead of both.

---

## 7. Sprint 3 (DONE — PR #98)

"Verifier pass on reviews." A **Haiku 4.5** faithfulness check after the Opus
review, all in `review.ts`:

- `verifyFindings(filing, sourceBody, findings)` — **one call per filing** (not
  per finding): sends the same truncated source body the reviewer saw + all
  candidate findings, returns a per-finding `faithful` verdict by index
  (`VERIFIER_SCHEMA`). Findings judged ungrounded are **dropped before
  `reviewFindings` is written** → they never reach the chat corpus either.
- **Best-effort:** a verifier error keeps all findings (`reviewVerified=false`);
  a missing verdict defaults to **keep**, so an incomplete response can't
  silently drop real findings.
- Interest is downgraded to `none`/unflagged **only** when verification removes
  *every* finding a filing had; a legitimately empty review is untouched.
- Verifier tokens are **logged** (`[verify] <accession>: kept X/Y, ~$Z`) but NOT
  folded into the Opus-priced `review_*_tokens` columns (would misprice the cap).
- **Migration #5** (`review_verifier_columns`) adds `review_verified` (boolean)
  + `verifier_explanation` (text) to `filings`. `null` for pre-Sprint-3 reviews.

**Scope (important — don't overclaim):** this catches the **fabrication** half of
S1/S2 and raises attacker cost via reviewer/verifier role separation. It does
**NOT** address **suppression** (the verifier only judges findings that exist),
and the verifier is itself injectable (mitigated by the Sprint 1 guidance, not
eliminated). The PR #98 description and squash message say this explicitly.

**Watch in prod:** the `[verify] … kept X/Y` logs. If lots of legitimate findings
get dropped, the verifier prompt is too strict — loosen `VERIFIER_SYSTEM`. Cost
note: the verifier re-sends the whole source to Haiku (≤400k chars → up to
~$0.10 on a giant 10-K; typically far less). Excerpt-based verification is the
dial if cost ever matters more than recall.

---

## 8. NEXT STEPS / open work

The original three-sprint plan is fully shipped. Remaining:

- **Suppression (S1) is still unaddressed** — the strongest open threat. No
  current control detects a real finding the reviewer was steered to *omit*.
  Candidate fix: an **affirmative-checklist review pass** that must answer
  "is there a related-party transaction? a parachute? an auditor change? a
  going-concern note?" so a missing answer is conspicuous. This is a different
  mechanism from the faithfulness verifier.
- **Optional UI surfacing** of the Sprint 3 data — a "verified" badge and/or the
  `verifier_explanation` (dropped-findings note) in the Findings tab. Stored but
  not shown today.
- **Operational follow-ups (not PRs):**
  - Stand up a **Promptfoo** regression suite (~20 injection payloads a hostile
    filer might try); run before every model bump.
  - Quarterly review of refusal rates + verifier drop rates per filing type.
  - **Re-do the whole threat model the moment the app gives Claude ANY tool** —
    tools change the blast radius from "content quality" to "actions," a
    completely different security posture.

---

## 9. How to resume in a new chat

1. Read this file.
2. `git checkout main && git pull` — confirm HEAD is at or past `63e997d`.
3. Ask the user what they observed from the latest deploys before starting new
   work: verifier drop rate (`[verify]` logs), any compare `omitted` notes,
   refusal rate. Confirm Sprints 1–3 + #97 are actually deployed (Railway is
   manual — merged ≠ deployed).
4. The obvious next build is the **suppression / affirmative-checklist** pass
   (§8) if the user prioritizes it. Follow the workflow in §2: feature branch →
   checks → PR → wait for the user to say "merge."
