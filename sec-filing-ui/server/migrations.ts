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
type Migration = { version: number; name: string; sql: string };

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
];

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
