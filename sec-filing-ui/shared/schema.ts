import { pgTable, serial, text, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ─── Users & Sessions ──────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // random UUID token
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  index("idx_sessions_user").on(table.userId),
  index("idx_sessions_expires").on(table.expiresAt),
]);

// ─── Watchlists (now scoped to a user) ────────────────────

export const watchlists = pgTable("watchlists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [
  index("idx_watchlists_user").on(table.userId),
]);

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

// A rendered filing PDF (now scoped to a user)
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
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [
  index("idx_filings_ticker").on(table.ticker),
  index("idx_filings_status").on(table.status),
  index("idx_filings_date").on(table.filingDate),
  index("idx_filings_type").on(table.filingType),
  index("idx_filings_ticker_status").on(table.ticker, table.status),
  index("idx_filings_user").on(table.userId),
]);

// ─── Watchlist Sharing ─────────────────────────────────────

export const watchlistShares = pgTable("watchlist_shares", {
  id: serial("id").primaryKey(),
  watchlistId: integer("watchlist_id").notNull().references(() => watchlists.id, { onDelete: "cascade" }),
  sharedWithUserId: integer("shared_with_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull().default("view"), // 'view' or 'edit'
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_share_unique").on(table.watchlistId, table.sharedWithUserId),
  index("idx_shares_user").on(table.sharedWithUserId),
]);

// ─── Insert schemas ────────────────────────────────────────

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertWatchlistSchema = createInsertSchema(watchlists).omit({ id: true });
export const insertTickerSchema = createInsertSchema(tickers).omit({ id: true });
export const insertFilingSchema = createInsertSchema(filings).omit({ id: true });
export const insertWatchlistShareSchema = createInsertSchema(watchlistShares).omit({ id: true });

// ─── Types ─────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Session = typeof sessions.$inferSelect;
export type Watchlist = typeof watchlists.$inferSelect;
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>;
export type Ticker = typeof tickers.$inferSelect;
export type InsertTicker = z.infer<typeof insertTickerSchema>;
export type Filing = typeof filings.$inferSelect;
export type InsertFiling = z.infer<typeof insertFilingSchema>;
export type WatchlistShare = typeof watchlistShares.$inferSelect;
export type InsertWatchlistShare = z.infer<typeof insertWatchlistShareSchema>;
