import type { Pool } from "pg";

// Versioned schema migrations.
//
// Each migration runs at most once, tracked in the `schema_migrations` table.
// Append new entries — never edit a migration that has already shipped, since
// some production DBs will already have applied it.
//
// On boot we read schema_migrations and apply only the unapplied entries, so
// the steady-state cost of "initDatabase()" is a single SELECT instead of the
// 30+ ALTER/CREATE/UPDATE statements the bootstrap block used to do.
//
// SAFETY: a migration that removes data (DROP TABLE/COLUMN/SCHEMA/DATABASE,
// TRUNCATE, DELETE FROM) can NEVER run silently. The runner scans each
// unapplied migration's SQL; if it finds data-destructive statements it:
//   - prints a loud, unmissable warning banner to the boot logs, AND
//   - REFUSES to apply it (throws, halting boot) unless the migration is
//     explicitly marked `destructive: true` to acknowledge the data loss.
// So an *accidental* destructive change fails the deploy instead of wiping
// data, and an *intentional* one still screams in the logs every time it runs.
type Migration = { version: number; name: string; sql: string; destructive?: boolean };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    // The original initDatabase DDL block. Idempotent (every statement uses
    // IF NOT EXISTS / IF EXISTS / WHERE NOT ...) so it's a safe no-op against
    // production databases where the schema already exists — and creates the
    // schema cleanly on a fresh DB.
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE watchlists DROP CONSTRAINT IF EXISTS watchlists_name_unique;

      CREATE TABLE IF NOT EXISTS tickers (
        id SERIAL PRIMARY KEY,
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        cik TEXT NOT NULL,
        filing_types TEXT NOT NULL DEFAULT '["10-K","10-Q","8-K"]'
      );

      ALTER TABLE filings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_status TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_materiality TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_summary TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_findings TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_error TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS reviewed_at TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_input_tokens INTEGER;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_output_tokens INTEGER;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_cache_read_tokens INTEGER;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_cache_creation_tokens INTEGER;
      CREATE INDEX IF NOT EXISTS idx_filings_review_status ON filings(review_status);

      -- Proxy statements (DEF 14A) are core to footnoted-style review. Add the
      -- form to any existing watchlist ticker that doesn't already track it.
      UPDATE tickers
        SET filing_types = ((filing_types::jsonb) || '["DEF 14A"]'::jsonb)::text
        WHERE filing_types IS NOT NULL
          AND NOT ((filing_types::jsonb) ? 'DEF 14A');

      CREATE TABLE IF NOT EXISTS watchlist_shares (
        id SERIAL PRIMARY KEY,
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'view',
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_share_unique ON watchlist_shares(watchlist_id, shared_with_user_id);
      CREATE INDEX IF NOT EXISTS idx_shares_user ON watchlist_shares(shared_with_user_id);

      CREATE TABLE IF NOT EXISTS finding_actions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        accession_number TEXT NOT NULL,
        finding_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_action_unique ON finding_actions(user_id, accession_number, finding_index);
      CREATE INDEX IF NOT EXISTS idx_finding_actions_user ON finding_actions(user_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tickers_watchlist ON tickers(watchlist_id);
      CREATE INDEX IF NOT EXISTS idx_tickers_ticker ON tickers(ticker);
      CREATE INDEX IF NOT EXISTS idx_filings_ticker ON filings(ticker);
      CREATE INDEX IF NOT EXISTS idx_filings_status ON filings(status);
      CREATE INDEX IF NOT EXISTS idx_filings_date ON filings(filing_date);
      CREATE INDEX IF NOT EXISTS idx_filings_type ON filings(filing_type);
      CREATE INDEX IF NOT EXISTS idx_filings_ticker_status ON filings(ticker, status);
      CREATE INDEX IF NOT EXISTS idx_filings_user ON filings(user_id);
      CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
    `,
  },
  {
    version: 2,
    name: "mdna_digest",
    sql: `
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_status TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_digest TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_error TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_analyzed_at TEXT;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_input_tokens INTEGER;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_output_tokens INTEGER;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_cache_read_tokens INTEGER;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS mdna_cache_creation_tokens INTEGER;
      CREATE INDEX IF NOT EXISTS idx_filings_mdna_status ON filings(mdna_status);
    `,
  },
  {
    version: 3,
    name: "filing_compares_cache",
    sql: `
      CREATE TABLE IF NOT EXISTS filing_compares (
        id SERIAL PRIMARY KEY,
        accession_low TEXT NOT NULL,
        accession_high TEXT NOT NULL,
        section TEXT NOT NULL,
        result TEXT NOT NULL,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_filing_compare_unique
        ON filing_compares(accession_low, accession_high, section);
      CREATE INDEX IF NOT EXISTS idx_filing_compare_low ON filing_compares(accession_low);
      CREATE INDEX IF NOT EXISTS idx_filing_compare_high ON filing_compares(accession_high);
    `,
  },
  {
    version: 4,
    name: "invalidate_compares_for_evidence_grounding",
    // Acknowledged data-removing migration (clears a regenerable cache table).
    // The flag is what lets the destructive-statement guard apply it instead of
    // halting boot — see the SAFETY note at the top of this file.
    destructive: true,
    // Sprint 2 added evidence grounding to compares: the model now quotes
    // verbatim source text per change and ungrounded entries are dropped.
    // Results cached under the old prompt/schema predate that filter, so
    // clear the cache and let them regenerate. The table itself is unchanged
    // (the new evidence fields are stripped before persisting), so this only
    // empties stale rows — it's a cache, nothing authoritative is lost.
    sql: `DELETE FROM filing_compares;`,
  },
  {
    version: 5,
    name: "review_verifier_columns",
    // Sprint 3: Haiku faithfulness verifier on reviews. review_verified is
    // true/false once the verifier runs (null for reviews from before this
    // shipped); verifier_explanation is a human-readable note of what it
    // dropped, or that everything passed.
    sql: `
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS review_verified BOOLEAN;
      ALTER TABLE filings ADD COLUMN IF NOT EXISTS verifier_explanation TEXT;
    `,
  },
  {
    version: 6,
    name: "filing_digest_cache",
    // Reusable structured "AI reading" of a filing, generated once and reused
    // by the single-filing chat so repeat sessions don't re-send the full text.
    sql: `ALTER TABLE filings ADD COLUMN IF NOT EXISTS filing_digest TEXT;`,
  },
  {
    version: 7,
    name: "watchlist_name_unique_per_user",
    // Watchlist names must be unique PER USER, not globally.
    //
    // Migration #1 tried to drop the legacy global constraint but named it
    // `watchlists_name_unique`. Postgres names a column-level UNIQUE
    // `<table>_<column>_key`, so the real constraint is `watchlists_name_key`
    // and the `IF EXISTS` turned that line into a silent no-op. The global
    // constraint therefore survived every migration run, and production shows
    // exactly what that implies: the S&P 500 seed failed for users 2, 3 and 4
    // with `duplicate key value violates unique constraint "watchlists_name_key"`
    // because user 1 already held a watchlist named "S&P 500". Any name any
    // user has ever used is burned for everyone.
    //
    // Drop it under both spellings (harmless if neither is present) and replace
    // it with the constraint that was actually intended. Users whose seed
    // failed self-heal: ensureSP500Seeded only records success, so the next
    // watchlist load retries.
    sql: `
      ALTER TABLE watchlists DROP CONSTRAINT IF EXISTS watchlists_name_key;
      ALTER TABLE watchlists DROP CONSTRAINT IF EXISTS watchlists_name_unique;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_user_name ON watchlists(user_id, name);
    `,
  },
  {
    version: 8,
    name: "usage_events_ledger",
    // Claude spend has to be CUMULATIVE, because it backs a hard cap.
    //
    // It wasn't. The total was derived from mutable current state:
    //   - review_*/mdna_* token columns are OVERWRITTEN on re-analysis, so a
    //     re-review erased the cost of the first one;
    //   - deleting a filing deleted its spend along with it;
    //   - filing_compares.cost_cents is upserted per (pair, section), so
    //     re-running a compare replaced the earlier charge, and migration #4's
    //     cache clear wiped every compare charge ever made.
    // Every one of those makes the counter go DOWN while real money was spent,
    // and a cap computed from a counter that can fall is not a cap.
    //
    // usage_events is append-only: one row per Claude call, priced when it
    // happens. Nothing updates or deletes it, so the total only ever grows.
    //
    // Costs are stored in MICRO-dollars (millionths). A single MD&A call runs
    // about $0.015, so whole cents would round most individual calls to 1 or 2
    // and drift badly over thousands of rows.
    //
    // The INSERTs below preserve the history that already exists so the cap
    // doesn't reset to zero on deploy. Prices are inlined rather than read from
    // pricing.ts on purpose: this is a snapshot of money already spent, and
    // repricing history at tomorrow's rates would be wrong. Per MTok at the
    // time of writing: $5 input, $25 output, $0.50 cache read, $6.25 cache
    // write — micros per token are those numbers exactly.
    sql: `
      CREATE TABLE IF NOT EXISTS usage_events (
        id BIGSERIAL PRIMARY KEY,
        path TEXT NOT NULL,
        accession_number TEXT,
        cost_micros BIGINT NOT NULL,
        input_tokens BIGINT,
        output_tokens BIGINT,
        cache_read_tokens BIGINT,
        cache_creation_tokens BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_path ON usage_events(path);
      CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);

      INSERT INTO usage_events
        (path, accession_number, cost_micros,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      SELECT 'review', accession_number,
        ROUND(COALESCE(review_input_tokens, 0) * 5.0
            + COALESCE(review_output_tokens, 0) * 25.0
            + COALESCE(review_cache_read_tokens, 0) * 0.5
            + COALESCE(review_cache_creation_tokens, 0) * 6.25),
        review_input_tokens, review_output_tokens,
        review_cache_read_tokens, review_cache_creation_tokens
      FROM filings
      WHERE review_input_tokens IS NOT NULL OR review_output_tokens IS NOT NULL;

      INSERT INTO usage_events
        (path, accession_number, cost_micros,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      SELECT 'mdna', accession_number,
        ROUND(COALESCE(mdna_input_tokens, 0) * 5.0
            + COALESCE(mdna_output_tokens, 0) * 25.0
            + COALESCE(mdna_cache_read_tokens, 0) * 0.5
            + COALESCE(mdna_cache_creation_tokens, 0) * 6.25),
        mdna_input_tokens, mdna_output_tokens,
        mdna_cache_read_tokens, mdna_cache_creation_tokens
      FROM filings
      WHERE mdna_input_tokens IS NOT NULL OR mdna_output_tokens IS NOT NULL;

      INSERT INTO usage_events (path, cost_micros)
      SELECT 'compare', cost_cents::bigint * 10000
      FROM filing_compares WHERE cost_cents > 0;

      -- Chat and the Haiku verifier previously accumulated in a settings
      -- counter. Carry its running total across as a single opening balance;
      -- new calls append their own rows and the counter is no longer read.
      INSERT INTO usage_events (path, cost_micros)
      SELECT 'other', COALESCE(NULLIF(value, ''), '0')::bigint * 10000
      FROM settings
      WHERE key = 'claude_spend_ledger_cents'
        AND COALESCE(NULLIF(value, ''), '0')::bigint > 0;
    `,
  },
];

// Data-removing statements we refuse to run silently. Note these are scoped to
// operations that destroy *rows or columns of data* — DROP TABLE/COLUMN/
// SCHEMA/DATABASE, TRUNCATE, DELETE FROM. `DROP CONSTRAINT` and `DROP INDEX`
// are intentionally NOT here: they remove schema rules, not data (migration #1
// legitimately drops a unique constraint), so flagging them would be noise.
const DESTRUCTIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { label: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { label: "DROP SCHEMA", re: /\bDROP\s+SCHEMA\b/i },
  { label: "DROP DATABASE", re: /\bDROP\s+DATABASE\b/i },
  { label: "TRUNCATE", re: /\bTRUNCATE\b/i },
  { label: "DELETE FROM", re: /\bDELETE\s+FROM\b/i },
];

// Strip SQL comments so a destructive keyword mentioned in a comment doesn't
// trip the guard (and, conversely, can't be used to hide real destructive SQL).
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " "); // line comments
}

// Return the labels of any data-destructive statements found in a migration's
// SQL. Empty array => safe (additive) migration. Exported for unit testing.
export function findDestructiveStatements(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  return DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(cleaned)).map((p) => p.label);
}

function warnDestructiveMigration(m: Migration, matched: string[]): void {
  const bar = "!".repeat(74);
  console.warn(
    [
      "",
      bar,
      `!!  DESTRUCTIVE MIGRATION #${m.version} (${m.name})`,
      `!!  Contains data-removing SQL: ${matched.join(", ")}`,
      "!!  Applying this PERMANENTLY DELETES data in the target database.",
      m.destructive === true
        ? "!!  Acknowledged via `destructive: true` — proceeding."
        : "!!  NOT acknowledged — refusing to apply (set `destructive: true` to allow).",
      bar,
      "",
    ].join("\n"),
  );
}

export async function runMigrations(pool: Pool): Promise<{ applied: number[] }> {
  // Bookkeeping table — own table so the user-facing schema stays clean.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
  const { rows } = await pool.query<{ version: number }>(
    `SELECT version FROM schema_migrations`,
  );
  const already = new Set(rows.map((r) => r.version));
  const newlyApplied: number[] = [];
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    if (already.has(m.version)) continue;

    // Guard: never let a data-destructive migration run silently. Warn loudly,
    // and refuse outright unless the author explicitly acknowledged it.
    const destructive = findDestructiveStatements(m.sql);
    if (destructive.length > 0) {
      warnDestructiveMigration(m, destructive);
      if (m.destructive !== true) {
        throw new Error(
          `[migrations] Refusing to apply migration #${m.version} (${m.name}): it contains ` +
            `data-destructive statements (${destructive.join(", ")}) but is not marked ` +
            "`destructive: true`. If the data loss is intentional, set that flag on the " +
            "migration to acknowledge it; otherwise remove the destructive SQL.",
        );
      }
    } else if (m.destructive === true) {
      // Flagged destructive but the detector saw nothing — surface the mismatch
      // rather than trusting a possibly-stale flag.
      console.warn(
        `[migrations] Migration #${m.version} (${m.name}) is marked destructive but no ` +
          "data-removing statement was detected — double-check the flag is still warranted.",
      );
    }

    await pool.query(m.sql);
    await pool.query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
      [m.version, m.name],
    );
    newlyApplied.push(m.version);
    console.log(`[migrations] Applied #${m.version} (${m.name}).`);
  }
  return { applied: newlyApplied };
}
