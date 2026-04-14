import {
  type User,
  type InsertUser,
  type Watchlist,
  type InsertWatchlist,
  type Ticker,
  type InsertTicker,
  type Filing,
  type InsertFiling,
  type WatchlistShare,
  type InsertWatchlistShare,
  users,
  sessions,
  watchlists,
  tickers,
  filings,
  watchlistShares,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, gte, lte, desc, inArray, sql, or } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required (e.g. postgres://user:pass@host:5432/dbname)");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool);

// Auto-create tables via raw SQL (runs once on startup)
export async function initDatabase(): Promise<void> {
  await pool.query(`
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

    -- Add user_id to watchlists (nullable initially for migration, then we'll handle it)
    ALTER TABLE watchlists ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    -- Remove unique constraint on name if it exists (now scoped per user, not globally unique)
    ALTER TABLE watchlists DROP CONSTRAINT IF EXISTS watchlists_name_unique;

    CREATE TABLE IF NOT EXISTS tickers (
      id SERIAL PRIMARY KEY,
      watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      cik TEXT NOT NULL,
      filing_types TEXT NOT NULL DEFAULT '["10-K","10-Q","8-K"]'
    );

    -- Add user_id to filings
    ALTER TABLE filings ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

    CREATE TABLE IF NOT EXISTS watchlist_shares (
      id SERIAL PRIMARY KEY,
      watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      shared_with_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'view',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_share_unique ON watchlist_shares(watchlist_id, shared_with_user_id);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON watchlist_shares(shared_with_user_id);

    -- Indexes for performance at scale
    CREATE INDEX IF NOT EXISTS idx_tickers_watchlist ON tickers(watchlist_id);
    CREATE INDEX IF NOT EXISTS idx_tickers_ticker ON tickers(ticker);
    CREATE INDEX IF NOT EXISTS idx_filings_ticker ON filings(ticker);
    CREATE INDEX IF NOT EXISTS idx_filings_status ON filings(status);
    CREATE INDEX IF NOT EXISTS idx_filings_date ON filings(filing_date);
    CREATE INDEX IF NOT EXISTS idx_filings_type ON filings(filing_type);
    CREATE INDEX IF NOT EXISTS idx_filings_ticker_status ON filings(ticker, status);
    CREATE INDEX IF NOT EXISTS idx_filings_user ON filings(user_id);
    CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
  `);
}

export class DatabaseStorage {
  // ─── Users ──────────────────────────────────────────────

  async getUserByEmail(email: string): Promise<User | undefined> {
    const rows = await db.select().from(users).where(sql`LOWER(${users.email}) = LOWER(${email})`);
    return rows[0];
  }

  async getUserById(id: number): Promise<User | undefined> {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0];
  }

  async createUser(data: InsertUser): Promise<User> {
    const rows = await db.insert(users).values(data).returning();
    return rows[0];
  }

  // ─── Sessions ───────────────────────────────────────────

  async createSession(id: string, userId: number, expiresAt: string): Promise<void> {
    await db.insert(sessions).values({ id, userId, expiresAt });
  }

  async getSession(id: string): Promise<{ userId: number; expiresAt: string } | undefined> {
    const rows = await db.select().from(sessions).where(eq(sessions.id, id));
    return rows[0];
  }

  async deleteSession(id: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, id));
  }

  async deleteExpiredSessions(): Promise<void> {
    await db.delete(sessions).where(lte(sessions.expiresAt, new Date().toISOString()));
  }

  // ─── Watchlists (scoped by userId) ─────────────────────

  async getWatchlists(userId: number): Promise<Watchlist[]> {
    return db.select().from(watchlists).where(eq(watchlists.userId, userId));
  }

  async getWatchlist(id: number): Promise<Watchlist | undefined> {
    const rows = await db.select().from(watchlists).where(eq(watchlists.id, id));
    return rows[0];
  }

  async createWatchlist(data: InsertWatchlist): Promise<Watchlist> {
    const rows = await db.insert(watchlists).values(data).returning();
    return rows[0];
  }

  async renameWatchlist(id: number, name: string): Promise<Watchlist | undefined> {
    const rows = await db
      .update(watchlists)
      .set({ name })
      .where(eq(watchlists.id, id))
      .returning();
    return rows[0];
  }

  async deleteWatchlist(id: number): Promise<void> {
    await db.delete(watchlists).where(eq(watchlists.id, id));
  }

  // ─── Watchlist Shares ───────────────────────────────────

  async getSharedWatchlists(userId: number): Promise<Array<Watchlist & { ownerName: string; ownerEmail: string; permission: string }>> {
    const rows = await db
      .select({
        id: watchlists.id,
        name: watchlists.name,
        userId: watchlists.userId,
        ownerName: users.displayName,
        ownerEmail: users.email,
        permission: watchlistShares.permission,
      })
      .from(watchlistShares)
      .innerJoin(watchlists, eq(watchlistShares.watchlistId, watchlists.id))
      .innerJoin(users, eq(watchlists.userId, users.id))
      .where(eq(watchlistShares.sharedWithUserId, userId));
    return rows;
  }

  async getWatchlistShares(watchlistId: number): Promise<Array<{ id: number; userId: number; email: string; displayName: string; permission: string }>> {
    const rows = await db
      .select({
        id: watchlistShares.id,
        userId: watchlistShares.sharedWithUserId,
        email: users.email,
        displayName: users.displayName,
        permission: watchlistShares.permission,
      })
      .from(watchlistShares)
      .innerJoin(users, eq(watchlistShares.sharedWithUserId, users.id))
      .where(eq(watchlistShares.watchlistId, watchlistId));
    return rows;
  }

  async createShare(data: InsertWatchlistShare): Promise<WatchlistShare> {
    const rows = await db.insert(watchlistShares).values(data).returning();
    return rows[0];
  }

  async deleteShare(watchlistId: number, userId: number): Promise<void> {
    await db.delete(watchlistShares).where(
      and(
        eq(watchlistShares.watchlistId, watchlistId),
        eq(watchlistShares.sharedWithUserId, userId),
      ),
    );
  }

  async getShareForUser(watchlistId: number, userId: number): Promise<WatchlistShare | undefined> {
    const rows = await db
      .select()
      .from(watchlistShares)
      .where(
        and(
          eq(watchlistShares.watchlistId, watchlistId),
          eq(watchlistShares.sharedWithUserId, userId),
        ),
      );
    return rows[0];
  }

  // ─── Tickers ────────────────────────────────────────────

  async getTickersByWatchlist(watchlistId: number): Promise<Ticker[]> {
    return db
      .select()
      .from(tickers)
      .where(eq(tickers.watchlistId, watchlistId));
  }

  async addTicker(data: InsertTicker): Promise<Ticker> {
    const rows = await db.insert(tickers).values(data).returning();
    return rows[0];
  }

  async removeTicker(id: number): Promise<void> {
    await db.delete(tickers).where(eq(tickers.id, id));
  }

  async updateTickerFilingTypes(id: number, filingTypes: string): Promise<Ticker | undefined> {
    const rows = await db
      .update(tickers)
      .set({ filingTypes })
      .where(eq(tickers.id, id))
      .returning();
    return rows[0];
  }

  // ─── Filings (scoped by userId) ────────────────────────

  async getFilings(userId: number, filters?: { ticker?: string; filingType?: string; dateFrom?: string; dateTo?: string; status?: string }): Promise<Filing[]> {
    const conditions: any[] = [eq(filings.userId, userId)];

    if (filters?.ticker) conditions.push(eq(filings.ticker, filters.ticker));
    if (filters?.filingType) conditions.push(eq(filings.filingType, filters.filingType));
    if (filters?.status) conditions.push(eq(filings.status, filters.status));
    if (filters?.dateFrom) conditions.push(gte(filings.filingDate, filters.dateFrom));
    if (filters?.dateTo) conditions.push(lte(filings.filingDate, filters.dateTo));

    return db.select().from(filings).where(and(...conditions)).orderBy(desc(filings.filingDate));
  }

  async getFilingByAccession(accession: string): Promise<Filing | undefined> {
    const rows = await db.select().from(filings).where(eq(filings.accessionNumber, accession));
    return rows[0];
  }

  async upsertFiling(data: InsertFiling): Promise<Filing> {
    const existing = await this.getFilingByAccession(data.accessionNumber);
    if (existing) {
      const rows = await db
        .update(filings)
        .set(data)
        .where(eq(filings.accessionNumber, data.accessionNumber))
        .returning();
      return rows[0];
    }
    const rows = await db.insert(filings).values(data).returning();
    return rows[0];
  }

  async updateFilingStatus(accession: string, status: string, pdfPath?: string, pdfSize?: number, errorMessage?: string): Promise<void> {
    const updates: any = { status };
    if (pdfPath !== undefined) updates.pdfPath = pdfPath;
    if (pdfSize !== undefined) updates.pdfSize = pdfSize;
    if (errorMessage !== undefined) updates.errorMessage = errorMessage;
    await db.update(filings).set(updates).where(eq(filings.accessionNumber, accession));
  }

  async deleteFiling(id: number): Promise<Filing | undefined> {
    const rows = await db.select().from(filings).where(eq(filings.id, id));
    const filing = rows[0];
    if (!filing) return undefined;
    await db.delete(filings).where(eq(filings.id, id));
    return filing;
  }

  async deleteFilings(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    await db.delete(filings).where(inArray(filings.id, ids));
    return ids.length;
  }

  async getFilingStats(userId: number): Promise<{ totalCount: number; completeCount: number; errorCount: number; totalSizeMb: number; tickers: string[]; filingTypes: string[] }> {
    const countResult = await pool.query(`
      SELECT
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE status = 'complete') as complete_count,
        COUNT(*) FILTER (WHERE status = 'error') as error_count,
        COALESCE(SUM(pdf_size) FILTER (WHERE status = 'complete'), 0) as total_bytes
      FROM filings
      WHERE user_id = $1
    `, [userId]);

    const tickerResult = await pool.query(`SELECT DISTINCT ticker FROM filings WHERE user_id = $1 ORDER BY ticker`, [userId]);
    const typeResult = await pool.query(`SELECT DISTINCT filing_type FROM filings WHERE user_id = $1 ORDER BY filing_type`, [userId]);

    const row = countResult.rows[0];
    return {
      totalCount: parseInt(row.total_count),
      completeCount: parseInt(row.complete_count),
      errorCount: parseInt(row.error_count),
      totalSizeMb: Math.round((parseInt(row.total_bytes) / 1024 / 1024) * 10) / 10,
      tickers: tickerResult.rows.map((r: any) => r.ticker),
      filingTypes: typeResult.rows.map((r: any) => r.filing_type),
    };
  }

  async getCompleteAccessions(userId: number, tickerList: string[]): Promise<Set<string>> {
    if (tickerList.length === 0) return new Set();
    const rows = await db
      .select({ accessionNumber: filings.accessionNumber })
      .from(filings)
      .where(
        and(
          eq(filings.userId, userId),
          inArray(filings.ticker, tickerList),
          eq(filings.status, "complete"),
        ),
      );
    return new Set(rows.map((r) => r.accessionNumber));
  }

  async exportWatchlistJson(userId: number): Promise<Array<{ cik: string; ticker: string; filing_types: string[] }>> {
    const userWatchlists = await this.getWatchlists(userId);
    const allTickers: Ticker[] = [];
    for (const wl of userWatchlists) {
      const t = await this.getTickersByWatchlist(wl.id);
      allTickers.push(...t);
    }
    const byCik = new Map<string, { cik: string; ticker: string; filing_types: Set<string> }>();
    for (const t of allTickers) {
      const types: string[] = JSON.parse(t.filingTypes);
      if (byCik.has(t.cik)) {
        const existing = byCik.get(t.cik)!;
        types.forEach((ft) => existing.filing_types.add(ft));
      } else {
        byCik.set(t.cik, { cik: t.cik, ticker: t.ticker, filing_types: new Set(types) });
      }
    }
    return Array.from(byCik.values()).map((e) => ({
      cik: e.cik,
      ticker: e.ticker,
      filing_types: Array.from(e.filing_types),
    }));
  }

  async getAllTickers(userId: number): Promise<Array<{ ticker: string; cik: string; filingTypes: string[] }>> {
    const userWatchlists = await this.getWatchlists(userId);
    const allTickers: Ticker[] = [];
    for (const wl of userWatchlists) {
      const t = await this.getTickersByWatchlist(wl.id);
      allTickers.push(...t);
    }
    const seen = new Map<string, { ticker: string; cik: string; filingTypes: Set<string> }>();
    for (const t of allTickers) {
      const types: string[] = JSON.parse(t.filingTypes);
      if (seen.has(t.ticker)) {
        types.forEach((ft) => seen.get(t.ticker)!.filingTypes.add(ft));
      } else {
        seen.set(t.ticker, { ticker: t.ticker, cik: t.cik, filingTypes: new Set(types) });
      }
    }
    return Array.from(seen.values()).map((e) => ({
      ticker: e.ticker,
      cik: e.cik,
      filingTypes: Array.from(e.filingTypes),
    }));
  }
}

export const storage = new DatabaseStorage();
