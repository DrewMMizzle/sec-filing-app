import {
  type Watchlist,
  type InsertWatchlist,
  type Ticker,
  type InsertTicker,
  type Filing,
  type InsertFiling,
  watchlists,
  tickers,
  filings,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, gte, lte, desc, inArray, sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required (e.g. postgres://user:pass@host:5432/dbname)");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,               // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool);

// Auto-create tables via raw SQL (runs once on startup)
// In production, use drizzle-kit migrations instead
export async function initDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS tickers (
      id SERIAL PRIMARY KEY,
      watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      cik TEXT NOT NULL,
      filing_types TEXT NOT NULL DEFAULT '["10-K","10-Q","8-K"]'
    );
    CREATE TABLE IF NOT EXISTS filings (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      cik TEXT NOT NULL,
      accession_number TEXT NOT NULL UNIQUE,
      filing_type TEXT NOT NULL,
      filing_date TEXT,
      pdf_path TEXT,
      pdf_size INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    -- Indexes for performance at scale
    CREATE INDEX IF NOT EXISTS idx_tickers_watchlist ON tickers(watchlist_id);
    CREATE INDEX IF NOT EXISTS idx_tickers_ticker ON tickers(ticker);
    CREATE INDEX IF NOT EXISTS idx_filings_ticker ON filings(ticker);
    CREATE INDEX IF NOT EXISTS idx_filings_status ON filings(status);
    CREATE INDEX IF NOT EXISTS idx_filings_date ON filings(filing_date);
    CREATE INDEX IF NOT EXISTS idx_filings_type ON filings(filing_type);
    CREATE INDEX IF NOT EXISTS idx_filings_ticker_status ON filings(ticker, status);
  `);
}

export interface IStorage {
  // Watchlists
  getWatchlists(): Promise<Watchlist[]>;
  getWatchlist(id: number): Promise<Watchlist | undefined>;
  createWatchlist(data: InsertWatchlist): Promise<Watchlist>;
  renameWatchlist(id: number, name: string): Promise<Watchlist | undefined>;
  deleteWatchlist(id: number): Promise<void>;

  // Tickers
  getTickersByWatchlist(watchlistId: number): Promise<Ticker[]>;
  addTicker(data: InsertTicker): Promise<Ticker>;
  removeTicker(id: number): Promise<void>;
  updateTickerFilingTypes(id: number, filingTypes: string): Promise<Ticker | undefined>;

  // Filings
  getFilings(filters?: { ticker?: string; filingType?: string; dateFrom?: string; dateTo?: string; status?: string }): Promise<Filing[]>;
  getFilingByAccession(accession: string): Promise<Filing | undefined>;
  upsertFiling(data: InsertFiling): Promise<Filing>;
  updateFilingStatus(accession: string, status: string, pdfPath?: string, pdfSize?: number, errorMessage?: string): Promise<void>;

  // Delete
  deleteFiling(id: number): Promise<Filing | undefined>;
  deleteFilings(ids: number[]): Promise<number>;

  // Stats
  getFilingStats(): Promise<{ totalCount: number; completeCount: number; errorCount: number; totalSizeMb: number; tickers: string[]; filingTypes: string[] }>;

  // Dedup
  getCompleteAccessions(tickerList: string[]): Promise<Set<string>>;

  // Export
  exportWatchlistJson(): Promise<Array<{ cik: string; ticker: string; filing_types: string[] }>>;
  getAllTickers(): Promise<Array<{ ticker: string; cik: string; filingTypes: string[] }>>;
}

export class DatabaseStorage implements IStorage {
  async getWatchlists(): Promise<Watchlist[]> {
    return db.select().from(watchlists);
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

  async getFilings(filters?: { ticker?: string; filingType?: string; dateFrom?: string; dateTo?: string; status?: string }): Promise<Filing[]> {
    const conditions: any[] = [];

    if (filters?.ticker) conditions.push(eq(filings.ticker, filters.ticker));
    if (filters?.filingType) conditions.push(eq(filings.filingType, filters.filingType));
    if (filters?.status) conditions.push(eq(filings.status, filters.status));
    if (filters?.dateFrom) conditions.push(gte(filings.filingDate, filters.dateFrom));
    if (filters?.dateTo) conditions.push(lte(filings.filingDate, filters.dateTo));

    if (conditions.length > 0) {
      return db.select().from(filings).where(and(...conditions)).orderBy(desc(filings.filingDate));
    }
    return db.select().from(filings).orderBy(desc(filings.filingDate));
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
    const result = await db.delete(filings).where(inArray(filings.id, ids));
    return ids.length; // pg driver doesn't return rowCount from drizzle delete easily
  }

  async getFilingStats(): Promise<{ totalCount: number; completeCount: number; errorCount: number; totalSizeMb: number; tickers: string[]; filingTypes: string[] }> {
    // Use aggregate queries instead of pulling all rows — scales to millions
    const countResult = await pool.query(`
      SELECT
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE status = 'complete') as complete_count,
        COUNT(*) FILTER (WHERE status = 'error') as error_count,
        COALESCE(SUM(pdf_size) FILTER (WHERE status = 'complete'), 0) as total_bytes
      FROM filings
    `);

    const tickerResult = await pool.query(`SELECT DISTINCT ticker FROM filings ORDER BY ticker`);
    const typeResult = await pool.query(`SELECT DISTINCT filing_type FROM filings ORDER BY filing_type`);

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

  async getCompleteAccessions(tickerList: string[]): Promise<Set<string>> {
    if (tickerList.length === 0) return new Set();
    const rows = await db
      .select({ accessionNumber: filings.accessionNumber })
      .from(filings)
      .where(
        and(
          inArray(filings.ticker, tickerList),
          eq(filings.status, "complete"),
        ),
      );
    return new Set(rows.map((r) => r.accessionNumber));
  }

  async exportWatchlistJson(): Promise<Array<{ cik: string; ticker: string; filing_types: string[] }>> {
    const allTickers = await db.select().from(tickers);
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

  async getAllTickers(): Promise<Array<{ ticker: string; cik: string; filingTypes: string[] }>> {
    const allTickers = await db.select().from(tickers);
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
