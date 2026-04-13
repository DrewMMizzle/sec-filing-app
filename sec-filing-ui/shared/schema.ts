import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// A named watchlist (e.g. "Defense", "Big Tech")
export const watchlists = pgTable("watchlists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

// A ticker belonging to one watchlist
export const tickers = pgTable("tickers", {
  id: serial("id").primaryKey(),
  watchlistId: integer("watchlist_id").notNull().references(() => watchlists.id, { onDelete: "cascade" }),
  ticker: text("ticker").notNull(),
  cik: text("cik").notNull(),
  filingTypes: text("filing_types").notNull().default('[\"10-K\",\"10-Q\",\"8-K\"]'), // JSON array stored as text
}, (table) => [
  index("idx_tickers_watchlist").on(table.watchlistId),
  index("idx_tickers_ticker").on(table.ticker),
]);

// A rendered filing PDF
export const filings = pgTable("filings", {
  id: serial("id").primaryKey(),
  ticker: text("ticker").notNull(),
  cik: text("cik").notNull(),
  accessionNumber: text("accession_number").notNull().unique(),
  filingType: text("filing_type").notNull(),
  filingDate: text("filing_date"), // YYYY-MM-DD
  pdfPath: text("pdf_path"),       // relative path to stored PDF
  pdfSize: integer("pdf_size"),    // bytes
  status: text("status").notNull().default("pending"), // pending | rendering | complete | error
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_filings_ticker").on(table.ticker),
  index("idx_filings_status").on(table.status),
  index("idx_filings_date").on(table.filingDate),
  index("idx_filings_type").on(table.filingType),
  index("idx_filings_ticker_status").on(table.ticker, table.status),
]);

// Insert schemas
export const insertWatchlistSchema = createInsertSchema(watchlists).omit({ id: true });
export const insertTickerSchema = createInsertSchema(tickers).omit({ id: true });
export const insertFilingSchema = createInsertSchema(filings).omit({ id: true });

// Types
export type Watchlist = typeof watchlists.$inferSelect;
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type Ticker = typeof tickers.$inferSelect;
export type InsertTicker = z.infer<typeof insertTickerSchema>;
export type Filing = typeof filings.$inferSelect;
export type InsertFiling = z.infer<typeof insertFilingSchema>;
