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
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, and, gte, lte, desc, inArray } from "drizzle-orm";

const DB_PATH = process.env.DATABASE_PATH || "data.db";
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

// Auto-create tables
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS tickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    cik TEXT NOT NULL,
    filing_types TEXT NOT NULL DEFAULT '["10-K","10-Q","8-K"]'
  );
  CREATE TABLE IF NOT EXISTS filings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
`);

export interface IStorage {
  // Watchlists
  getWatchlists(): Watchlist[];
  getWatchlist(id: number): Watchlist | undefined;
  createWatchlist(data: InsertWatchlist): Watchlist;
  renameWatchlist(id: number, name: string): Watchlist | undefined;
  deleteWatchlist(id: number): void;

  // Tickers
  getTickersByWatchlist(watchlistId: number): Ticker[];
  addTicker(data: InsertTicker): Ticker;
  removeTicker(id: number): void;
  updateTickerFilingTypes(id: number, filingTypes: string): Ticker | undefined;

  // Filings
  getFilings(filters?: { ticker?: string; filingType?: string; dateFrom?: string; dateTo?: string; status?: string }): Filing[];
  getFilingByAccession(accession: string): Filing | undefined;
  upsertFiling(data: InsertFiling): Filing;
  updateFilingStatus(accession: string, status: string, pdfPath?: string, pdfSize?: number, errorMessage?: string): void;

  // Delete
  deleteFiling(id: number): Filing | undefined;
  deleteFilings(ids: number[]): number;

  // Stats
  getFilingStats(): { totalCount: number; completeCount: number; errorCount: number; totalSizeMb: number; tickers: string[]; filingTypes: string[] };

  // Dedup
  getCompleteAccessions(tickerList: string[]): Set<string>;

  // Export
  exportWatchlistJson(): Array<{ cik: string; ticker: string; filing_types: string[] }>;
  getAllTickers(): Array<{ ticker: string; cik: string; filingTypes: string[] }>;
}

export class DatabaseStorage implements IStorage {
  getWatchlists(): Watchlist[] {
    return db.select().from(watchlists).all();
  }

  getWatchlist(id: number): Watchlist | undefined {
    return db.select().from(watchlists).where(eq(watchlists.id, id)).get();
  }

  createWatchlist(data: InsertWatchlist): Watchlist {
    return db.insert(watchlists).values(data).returning().get();
  }

  renameWatchlist(id: number, name: string): Watchlist | undefined {
    return db
      .update(watchlists)
      .set({ name })
      .where(eq(watchlists.id, id))
      .returning()
      .get();
  }

  deleteWatchlist(id: number): void {
    db.delete(watchlists).where(eq(watchlists.id, id)).run();
  }

  getTickersByWatchlist(watchlistId: number): Ticker[] {
    return db
      .select()
      .from(tickers)
      .where(eq(tickers.watchlistId, watchlistId))
      .all();
  }

  addTicker(data: InsertTicker): Ticker {
    return db.insert(tickers).values(data).returning().get();
  }

  removeTicker(id: number): void {
    db.delete(tickers).where(eq(tickers.id, id)).run();
  }

  updateTickerFilingTypes(id: number, filingTypes: string): Ticker | undefined {
    return db
      .update(tickers)
      .set({ filingTypes })
      .where(eq(tickers.id, id))
      .returning()
      .get();
  }

  getFilings(filters?: { ticker?: string; filingType?: string; dateFrom?: string; dateTo?: string; status?: string }): Filing[] {
    let query = db.select().from(filings);
    const conditions: any[] = [];

    if (filters?.ticker) conditions.push(eq(filings.ticker, filters.ticker));
    if (filters?.filingType) conditions.push(eq(filings.filingType, filters.filingType));
    if (filters?.status) conditions.push(eq(filings.status, filters.status));
    if (filters?.dateFrom) conditions.push(gte(filings.filingDate, filters.dateFrom));
    if (filters?.dateTo) conditions.push(lte(filings.filingDate, filters.dateTo));

    if (conditions.length > 0) {
      return (query as any).where(and(...conditions)).orderBy(desc(filings.filingDate)).all();
    }
    return (query as any).orderBy(desc(filings.filingDate)).all();
  }

  getFilingByAccession(accession: string): Filing | undefined {
    return db.select().from(filings).where(eq(filings.accessionNumber, accession)).get();
  }

  upsertFiling(data: InsertFiling): Filing {
    const existing = this.getFilingByAccession(data.accessionNumber);
    if (existing) {
      return db
        .update(filings)
        .set(data)
        .where(eq(filings.accessionNumber, data.accessionNumber))
        .returning()
        .get();
    }
    return db.insert(filings).values(data).returning().get();
  }

  updateFilingStatus(accession: string, status: string, pdfPath?: string, pdfSize?: number, errorMessage?: string): void {
    const updates: any = { status };
    if (pdfPath !== undefined) updates.pdfPath = pdfPath;
    if (pdfSize !== undefined) updates.pdfSize = pdfSize;
    if (errorMessage !== undefined) updates.errorMessage = errorMessage;
    db.update(filings).set(updates).where(eq(filings.accessionNumber, accession)).run();
  }

  deleteFiling(id: number): Filing | undefined {
    const filing = db.select().from(filings).where(eq(filings.id, id)).get();
    if (!filing) return undefined;
    db.delete(filings).where(eq(filings.id, id)).run();
    return filing;
  }

  deleteFilings(ids: number[]): number {
    if (ids.length === 0) return 0;
    let count = 0;
    for (const id of ids) {
      const result = db.delete(filings).where(eq(filings.id, id)).run();
      count += result.changes;
    }
    return count;
  }

  getFilingStats(): { totalCount: number; completeCount: number; errorCount: number; totalSizeMb: number; tickers: string[]; filingTypes: string[] } {
    const all = db.select().from(filings).all();
    const complete = all.filter((f) => f.status === "complete");
    const errors = all.filter((f) => f.status === "error");
    const totalBytes = complete.reduce((sum, f) => sum + (f.pdfSize || 0), 0);
    const tickerSet = new Set(all.map((f) => f.ticker));
    const typeSet = new Set(all.map((f) => f.filingType));
    return {
      totalCount: all.length,
      completeCount: complete.length,
      errorCount: errors.length,
      totalSizeMb: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
      tickers: Array.from(tickerSet).sort(),
      filingTypes: Array.from(typeSet).sort(),
    };
  }

  getCompleteAccessions(tickerList: string[]): Set<string> {
    if (tickerList.length === 0) return new Set();
    const rows = db
      .select({ accessionNumber: filings.accessionNumber })
      .from(filings)
      .where(
        and(
          inArray(filings.ticker, tickerList),
          eq(filings.status, "complete"),
        ),
      )
      .all();
    return new Set(rows.map((r) => r.accessionNumber));
  }

  exportWatchlistJson(): Array<{ cik: string; ticker: string; filing_types: string[] }> {
    const allTickers = db.select().from(tickers).all();
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

  getAllTickers(): Array<{ ticker: string; cik: string; filingTypes: string[] }> {
    const allTickers = db.select().from(tickers).all();
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
