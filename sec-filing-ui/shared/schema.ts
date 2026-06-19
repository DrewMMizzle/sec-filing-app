import { pgTable, serial, text, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
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
  filingTypes: text("filing_types").notNull().default('[\"10-K\",\"10-Q\",\"8-K\",\"DEF 14A\"]'), // JSON array stored as text
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
  // Claude footnoted-style editorial review
  reviewStatus: text("review_status"),          // null (not requested) | pending | reviewing | done | error
  reviewFlagged: boolean("review_flagged"),     // true if there's something post-worthy here
  reviewMateriality: text("review_materiality"),// overall interest level: high | medium | low | none
  reviewSummary: text("review_summary"),        // one-line lead / why this filing is worth a look
  reviewFindings: text("review_findings"),      // JSON array of findings [{category, headline, detail, why}]
  reviewError: text("review_error"),
  reviewedAt: text("reviewed_at"),
  // Actual Claude token usage from the review (for cost tracking)
  reviewInputTokens: integer("review_input_tokens"),
  reviewOutputTokens: integer("review_output_tokens"),
  reviewCacheReadTokens: integer("review_cache_read_tokens"),
  reviewCacheCreationTokens: integer("review_cache_creation_tokens"),
  // Analyst-oriented MD&A digest (10-K Item 7 / 10-Q Item 2). Generated on
  // demand, separate from the editorial review above.
  mdnaStatus: text("mdna_status"),               // null (not run) | analyzing | done | error
  mdnaDigest: text("mdna_digest"),               // JSON object {overview, revenue_drivers, margins, segments, guidance, other}
  mdnaError: text("mdna_error"),
  mdnaAnalyzedAt: text("mdna_analyzed_at"),
  mdnaInputTokens: integer("mdna_input_tokens"),
  mdnaOutputTokens: integer("mdna_output_tokens"),
  mdnaCacheReadTokens: integer("mdna_cache_read_tokens"),
  mdnaCacheCreationTokens: integer("mdna_cache_creation_tokens"),
}, (table) => [
  index("idx_filings_ticker").on(table.ticker),
  index("idx_filings_status").on(table.status),
  index("idx_filings_date").on(table.filingDate),
  index("idx_filings_type").on(table.filingType),
  index("idx_filings_ticker_status").on(table.ticker, table.status),
  index("idx_filings_user").on(table.userId),
  index("idx_filings_review_status").on(table.reviewStatus),
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

// ─── Per-finding triage state ──────────────────────────────

export const findingActions = pgTable("finding_actions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessionNumber: text("accession_number").notNull(),
  findingIndex: integer("finding_index").notNull(),
  status: text("status").notNull(), // starred | dismissed | posted
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_finding_action_unique").on(table.userId, table.accessionNumber, table.findingIndex),
  index("idx_finding_actions_user").on(table.userId),
]);

// ─── App-wide settings (key/value) ─────────────────────────

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

// ─── Cached compare results ────────────────────────────────
//
// Caches the JSON output of /api/compare and /api/registration/compare-pdfs
// keyed on the (sorted) accession pair + section. Repeat clicks on the
// same pair return the cached row without re-calling Claude. The cache
// is invalidated when either accession is queued for re-render.

export const filingCompares = pgTable("filing_compares", {
  id: serial("id").primaryKey(),
  // Sorted so the pair is order-insensitive: accessionLow <= accessionHigh.
  accessionLow: text("accession_low").notNull(),
  accessionHigh: text("accession_high").notNull(),
  // Section key for /api/compare ("risk_factors" | "mdna" | "legal") or
  // the sentinel "__whole__" for whole-filing registration compares.
  section: text("section").notNull(),
  // Full JSON result body returned by the compare endpoint — stored
  // verbatim so the cached path returns exactly what the live path would.
  result: text("result").notNull(),
  // Stored as cents (integer) to avoid float drift across reads.
  costCents: integer("cost_cents").notNull().default(0),
  createdAt: text("created_at").notNull(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => [
  uniqueIndex("idx_filing_compare_unique").on(
    table.accessionLow, table.accessionHigh, table.section,
  ),
  index("idx_filing_compare_low").on(table.accessionLow),
  index("idx_filing_compare_high").on(table.accessionHigh),
]);

// ─── Insert schemas ────────────────────────────────────────

export const insertUserSchema = createInsertSchema(users).omit({ id: true });
export const insertWatchlistSchema = createInsertSchema(watchlists).omit({ id: true });
export const insertTickerSchema = createInsertSchema(tickers).omit({ id: true });
export const insertFilingSchema = createInsertSchema(filings).omit({ id: true });
export const insertWatchlistShareSchema = createInsertSchema(watchlistShares).omit({ id: true });
export const insertFindingActionSchema = createInsertSchema(findingActions).omit({ id: true });

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
export type FindingAction = typeof findingActions.$inferSelect;
export type InsertFindingAction = z.infer<typeof insertFindingActionSchema>;
export type Setting = typeof settings.$inferSelect;
export type FilingCompare = typeof filingCompares.$inferSelect;
