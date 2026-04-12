import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// A named watchlist (e.g. "Defense", "Big Tech")
export const watchlists = sqliteTable("watchlists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

// A ticker belonging to one watchlist
export const tickers = sqliteTable("tickers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  watchlistId: integer("watchlist_id").notNull().references(() => watchlists.id, { onDelete: "cascade" }),
  ticker: text("ticker").notNull(),
  cik: text("cik").notNull(),
  filingTypes: text("filing_types").notNull().default('["10-K","10-Q","8-K"]'), // JSON array stored as text
});

// A rendered filing PDF
export const filings = sqliteTable("filings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  cik: text("cik").notNull(),
  accessionNumber: text("accession_number").notNull().unique(),
  filingType: text("filing_type").notNull(),
  filingDate: text("filing_date"), // YYYY-MM-DD
  pdfPath: text("pdf_path"),       // relative path to output/filings/...
  pdfSize: integer("pdf_size"),    // bytes
  status: text("status").notNull().default("pending"), // pending | rendering | complete | error
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
});

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
