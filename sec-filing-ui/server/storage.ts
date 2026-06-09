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
  type FindingAction,
  type InsertFindingAction,
  users,
  sessions,
  watchlists,
  tickers,
  filings,
  watchlistShares,
  findingActions,
  settings,
  filingCompares,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, gte, lte, asc, desc, inArray, sql, or, isNull } from "drizzle-orm";
import { runMigrations } from "./migrations";

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

// Parse a ticker row's filingTypes column without ever throwing. The column is
// stored as a JSON-encoded string, but a corrupted or hand-edited value used
// to crash callers — and on the client, leak through to a blank Fetch page.
// Anything unrecognizable becomes an empty array so callers keep working.
export function parseFilingTypesSafe(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

// Slim-mode helper: null out the heavy reviewFindings JSON blob (often hundreds
// of KB per filing) before returning a list, so polled views don't ship MB of
// JSON the consumer isn't going to render. Short text fields (reviewSummary,
// reviewError) stay so the list can still show status messages without an
// extra round-trip. We attach a findingsCount integer so the UI can still show
// "N findings" without needing to parse the full array. Detail endpoints fetch
// the full row.
function stripHeavyReviewFields(rows: Filing[]): void {
  for (const r of rows) {
    const extras = r as Filing & { findingsCount?: number };
    let count = 0;
    if (r.reviewFindings) {
      try {
        const parsed = JSON.parse(r.reviewFindings);
        if (Array.isArray(parsed)) count = parsed.length;
      } catch {
        // Leave count at 0 on parse failure.
      }
    }
    extras.findingsCount = count;
    r.reviewFindings = null;
    // The MD&A digest JSON is likewise heavy and only rendered on its own tab.
    r.mdnaDigest = null;
  }
}

// Run versioned schema migrations on boot. The bulk of the DDL only runs the
// first time (or on schema upgrades) — steady-state boot is a single SELECT
// against schema_migrations.
export async function initDatabase(): Promise<void> {
  const { applied } = await runMigrations(pool);
  if (applied.length === 0) {
    console.log("[migrations] Schema already up to date.");
  }
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

  // Filings are a shared team corpus (no per-user filter).
  // Pass `slim: true` to strip the heavy text fields (reviewFindings,
  // reviewSummary, reviewError) from the response — list views don't need them,
  // and they can dominate the payload size on filings with rich reviews.
  async getFilings(filters?: {
    ticker?: string;
    filingType?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
    slim?: boolean;
  }): Promise<Filing[]> {
    const conditions: any[] = [];

    if (filters?.ticker) conditions.push(eq(filings.ticker, filters.ticker));
    if (filters?.filingType) conditions.push(eq(filings.filingType, filters.filingType));
    if (filters?.status) conditions.push(eq(filings.status, filters.status));
    if (filters?.dateFrom) conditions.push(gte(filings.filingDate, filters.dateFrom));
    if (filters?.dateTo) conditions.push(lte(filings.filingDate, filters.dateTo));

    const query = db.select().from(filings);
    const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
    const sorted = rows.sort((a, b) => (b.filingDate || "").localeCompare(a.filingDate || ""));
    if (filters?.slim) stripHeavyReviewFields(sorted);
    return sorted;
  }

  // Paginated/filterable/sortable variant of getFilings — pushes all of the
  // PDF-library page's filter/sort/search work into SQL (with indexes on
  // ticker, status, filingDate, filingType) so the client only ever ships a
  // page-worth of rows over the wire. Pass `slim: true` to also strip the
  // heavy review-text fields from the response.
  async getFilingsPage(opts: {
    ticker?: string;
    filingType?: string;
    status?: string;
    reviewStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    q?: string;
    sort?: string;
    dir?: "asc" | "desc";
    limit?: number;
    offset?: number;
    slim?: boolean;
  } = {}): Promise<{ items: Filing[]; total: number }> {
    const conditions: any[] = [];
    if (opts.ticker) conditions.push(eq(filings.ticker, opts.ticker));
    if (opts.filingType) conditions.push(eq(filings.filingType, opts.filingType));
    if (opts.status) conditions.push(eq(filings.status, opts.status));
    if (opts.reviewStatus) conditions.push(eq(filings.reviewStatus, opts.reviewStatus));
    if (opts.dateFrom) conditions.push(gte(filings.filingDate, opts.dateFrom));
    if (opts.dateTo) conditions.push(lte(filings.filingDate, opts.dateTo));
    if (opts.q && opts.q.trim()) {
      const like = `%${opts.q.trim().toLowerCase()}%`;
      conditions.push(
        or(
          sql`LOWER(${filings.ticker}) LIKE ${like}`,
          sql`LOWER(${filings.accessionNumber}) LIKE ${like}`,
          sql`LOWER(${filings.filingType}) LIKE ${like}`,
        ),
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Total count for pagination — separate query to keep it cheap.
    const countQuery = db
      .select({ c: sql<number>`count(*)::int` })
      .from(filings);
    const totalRows = where ? await countQuery.where(where) : await countQuery;
    const total = totalRows[0]?.c ?? 0;

    const sortMap: Record<string, any> = {
      filingDate: filings.filingDate,
      ticker: filings.ticker,
      filingType: filings.filingType,
      status: filings.status,
      pdfSize: filings.pdfSize,
      reviewedAt: filings.reviewedAt,
    };
    const sortColumn = sortMap[opts.sort ?? "filingDate"] ?? filings.filingDate;
    const orderFn = opts.dir === "asc" ? asc : desc;
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);

    const base = db.select().from(filings);
    const items = await (where ? base.where(where) : base)
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    const typedItems = items as Filing[];
    if (opts.slim) stripHeavyReviewFields(typedItems);
    return { items: typedItems, total };
  }

  async getFilingByAccession(accession: string): Promise<Filing | undefined> {
    const rows = await db.select().from(filings).where(eq(filings.accessionNumber, accession));
    return rows[0];
  }

  // Batch status lookup — the registration UI needs to know which EDGAR-listed
  // S-1 / S-1/A filings already have a DB row (and at what status / review
  // state) so it only shows the Review button for filings that are actually
  // rendered. Returns just the small status fields, not the heavy review JSON.
  async getFilingStatusesByAccessions(accessions: string[]): Promise<
    Array<{ accessionNumber: string; status: string; reviewStatus: string | null }>
  > {
    if (accessions.length === 0) return [];
    const rows = await db
      .select({
        accessionNumber: filings.accessionNumber,
        status: filings.status,
        reviewStatus: filings.reviewStatus,
      })
      .from(filings)
      .where(inArray(filings.accessionNumber, accessions));
    return rows;
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

  // ─── Material-disclosure review ─────────────────────────

  async markFilingForReview(accession: string): Promise<void> {
    await db.update(filings).set({ reviewStatus: "pending" }).where(eq(filings.accessionNumber, accession));
  }

  // Queue every rendered filing in the shared corpus that hasn't been
  // successfully reviewed yet (never reviewed or previously errored).
  async markCompleteFilingsForReview(): Promise<number> {
    const rows = await db
      .update(filings)
      .set({ reviewStatus: "pending" })
      .where(
        and(
          eq(filings.status, "complete"),
          or(isNull(filings.reviewStatus), eq(filings.reviewStatus, "error")),
        ),
      )
      .returning({ id: filings.id });
    return rows.length;
  }

  // Same, but scoped to a set of tickers — used after a fetch so already-rendered
  // (dedup-skipped) filings that were never reviewed still get queued.
  async markCompleteFilingsForReviewByTickers(tickerList: string[]): Promise<number> {
    if (tickerList.length === 0) return 0;
    const rows = await db
      .update(filings)
      .set({ reviewStatus: "pending" })
      .where(
        and(
          inArray(filings.ticker, tickerList),
          eq(filings.status, "complete"),
          or(isNull(filings.reviewStatus), eq(filings.reviewStatus, "error")),
        ),
      )
      .returning({ id: filings.id });
    return rows.length;
  }

  async requeueStaleReviews(): Promise<void> {
    // Reset rows left mid-review by a crash/restart back to the queue.
    await db.update(filings).set({ reviewStatus: "pending" }).where(eq(filings.reviewStatus, "reviewing"));
  }

  // Filings left at status='rendering' by a crashed/killed/stalled fetch never
  // produced a PDF, so they'd otherwise spin forever. Flip them to 'error' so
  // the UI settles and they can be retried via re-fetch. Optionally scope to a
  // set of tickers (used right after a fetch run) or to rows older than N
  // minutes (used by the periodic sweep so an in-flight render isn't killed).
  async recoverStaleRenders(opts?: {
    tickerList?: string[];
    olderThanMinutes?: number;
  }): Promise<number> {
    const tickerList = opts?.tickerList;
    const olderThanMinutes = opts?.olderThanMinutes;
    const conditions: any[] = [eq(filings.status, "rendering")];
    if (tickerList && tickerList.length > 0) conditions.push(inArray(filings.ticker, tickerList));
    if (olderThanMinutes !== undefined && olderThanMinutes > 0) {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
      conditions.push(lte(filings.createdAt, cutoff));
    }
    const rows = await db
      .update(filings)
      .set({
        status: "error",
        errorMessage:
          olderThanMinutes !== undefined
            ? `Render stuck >${olderThanMinutes} min — pipeline likely died. Re-fetch to retry.`
            : "Render interrupted before completion — re-fetch to retry.",
      })
      .where(and(...conditions))
      .returning({ id: filings.id });
    return rows.length;
  }

  async getPendingReviewFilings(limit = 5): Promise<Filing[]> {
    return db
      .select()
      .from(filings)
      .where(eq(filings.reviewStatus, "pending"))
      .limit(limit);
  }

  async setFilingReviewStatus(accession: string, status: string | null): Promise<void> {
    await db.update(filings).set({ reviewStatus: status }).where(eq(filings.accessionNumber, accession));
  }

  // Drop every still-queued filing back to "not requested" — used when the
  // user cancels an in-flight fetch+review run so the remaining queued items
  // don't keep churning the moment the next kick fires.
  async clearPendingReviews(): Promise<number> {
    const result = await pool.query(
      `UPDATE filings SET review_status = NULL WHERE review_status = 'pending'`,
    );
    return result.rowCount ?? 0;
  }

  async setFilingReviewResult(
    accession: string,
    result: { interesting: boolean; interestingness: string; summary: string; findings: unknown[] },
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    },
  ): Promise<void> {
    await db
      .update(filings)
      .set({
        reviewStatus: "done",
        reviewFlagged: result.interesting,
        reviewMateriality: result.interestingness,
        reviewSummary: result.summary,
        reviewFindings: JSON.stringify(result.findings),
        reviewInputTokens: usage?.inputTokens ?? null,
        reviewOutputTokens: usage?.outputTokens ?? null,
        reviewCacheReadTokens: usage?.cacheReadTokens ?? null,
        reviewCacheCreationTokens: usage?.cacheCreationTokens ?? null,
        reviewError: null,
        reviewedAt: new Date().toISOString(),
      })
      .where(eq(filings.accessionNumber, accession));
  }

  // Team-wide review spend (shared corpus).
  async getReviewUsage(): Promise<{
    reviewedCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE review_input_tokens IS NOT NULL) AS reviewed_count,
         COALESCE(SUM(review_input_tokens), 0) AS input_tokens,
         COALESCE(SUM(review_output_tokens), 0) AS output_tokens,
         COALESCE(SUM(review_cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(review_cache_creation_tokens), 0) AS cache_creation_tokens
       FROM filings`,
    );
    const row = result.rows[0];
    return {
      reviewedCount: parseInt(row.reviewed_count, 10),
      inputTokens: parseInt(row.input_tokens, 10),
      outputTokens: parseInt(row.output_tokens, 10),
      cacheReadTokens: parseInt(row.cache_read_tokens, 10),
      cacheCreationTokens: parseInt(row.cache_creation_tokens, 10),
    };
  }

  // ─── App settings (key/value) ───────────────────────────

  async getSetting(key: string): Promise<string | null> {
    const rows = await db.select().from(settings).where(eq(settings.key, key));
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    // Atomic upsert so concurrent first-time writes to the same key can't both
    // INSERT and trip the primary-key constraint.
    await db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  // The team-wide max review spend in USD, or null if no cap is set.
  async getReviewBudgetUsd(): Promise<number | null> {
    const raw = await this.getSetting("review_budget_usd");
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async getPendingReviewCount(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) AS c FROM filings WHERE review_status = 'pending'`,
    );
    return parseInt(result.rows[0].c, 10);
  }

  async setFilingReviewError(accession: string, message: string): Promise<void> {
    await db
      .update(filings)
      .set({ reviewStatus: "error", reviewError: message, reviewedAt: new Date().toISOString() })
      .where(eq(filings.accessionNumber, accession));
  }

  // ─── MD&A digest (analyst-oriented, on demand) ──────────

  async setFilingMdnaStatus(accession: string, status: string): Promise<void> {
    await db.update(filings).set({ mdnaStatus: status }).where(eq(filings.accessionNumber, accession));
  }

  async setFilingMdnaResult(
    accession: string,
    digest: unknown,
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    },
  ): Promise<void> {
    await db
      .update(filings)
      .set({
        mdnaStatus: "done",
        mdnaDigest: JSON.stringify(digest),
        mdnaError: null,
        mdnaAnalyzedAt: new Date().toISOString(),
        mdnaInputTokens: usage?.inputTokens ?? null,
        mdnaOutputTokens: usage?.outputTokens ?? null,
        mdnaCacheReadTokens: usage?.cacheReadTokens ?? null,
        mdnaCacheCreationTokens: usage?.cacheCreationTokens ?? null,
      })
      .where(eq(filings.accessionNumber, accession));
  }

  async setFilingMdnaError(accession: string, message: string): Promise<void> {
    await db
      .update(filings)
      .set({ mdnaStatus: "error", mdnaError: message, mdnaAnalyzedAt: new Date().toISOString() })
      .where(eq(filings.accessionNumber, accession));
  }

  // ─── Per-finding triage actions ─────────────────────────

  async getFindingActions(userId: number): Promise<FindingAction[]> {
    return db.select().from(findingActions).where(eq(findingActions.userId, userId));
  }

  async setFindingAction(
    userId: number,
    accessionNumber: string,
    findingIndex: number,
    status: string,
  ): Promise<void> {
    const existing = await db
      .select()
      .from(findingActions)
      .where(
        and(
          eq(findingActions.userId, userId),
          eq(findingActions.accessionNumber, accessionNumber),
          eq(findingActions.findingIndex, findingIndex),
        ),
      );
    const updatedAt = new Date().toISOString();
    if (existing[0]) {
      await db
        .update(findingActions)
        .set({ status, updatedAt })
        .where(eq(findingActions.id, existing[0].id));
    } else {
      await db.insert(findingActions).values({ userId, accessionNumber, findingIndex, status, updatedAt });
    }
  }

  async clearFindingAction(userId: number, accessionNumber: string, findingIndex: number): Promise<void> {
    await db
      .delete(findingActions)
      .where(
        and(
          eq(findingActions.userId, userId),
          eq(findingActions.accessionNumber, accessionNumber),
          eq(findingActions.findingIndex, findingIndex),
        ),
      );
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

  // Tiny aggregate intended for fast polling. Carries enough signal for the
  // Fetch & Review and Findings pages to detect activity (rendering /
  // reviewing in flight) and changes (lastReviewedAt advances when a new
  // review lands) without shipping any row data.
  async getFilingsProgress(): Promise<{
    totalCount: number;
    rendering: number;
    renderError: number;
    pendingReview: number;
    reviewing: number;
    doneReview: number;
    reviewError: number;
    lastReviewedAt: string | null;
  }> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE status = 'rendering') as rendering,
        COUNT(*) FILTER (WHERE status = 'error') as render_error,
        COUNT(*) FILTER (WHERE review_status = 'pending') as pending_review,
        COUNT(*) FILTER (WHERE review_status = 'reviewing') as reviewing,
        COUNT(*) FILTER (WHERE review_status = 'done') as done_review,
        COUNT(*) FILTER (WHERE review_status = 'error') as review_error,
        MAX(reviewed_at) as last_reviewed_at
      FROM filings
    `);
    const row = result.rows[0];
    return {
      totalCount: parseInt(row.total_count),
      rendering: parseInt(row.rendering),
      renderError: parseInt(row.render_error),
      pendingReview: parseInt(row.pending_review),
      reviewing: parseInt(row.reviewing),
      doneReview: parseInt(row.done_review),
      reviewError: parseInt(row.review_error),
      lastReviewedAt: row.last_reviewed_at ?? null,
    };
  }

  // Team-wide stats (shared corpus).
  async getFilingStats(): Promise<{ totalCount: number; completeCount: number; errorCount: number; totalSizeMb: number; tickers: string[]; filingTypes: string[] }> {
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

  // Shared-corpus dedup: any complete filing counts, regardless of who fetched it.
  async getCompleteFilings(
    tickerList: string[],
  ): Promise<Array<{ accessionNumber: string; pdfPath: string | null }>> {
    if (tickerList.length === 0) return [];
    return db
      .select({ accessionNumber: filings.accessionNumber, pdfPath: filings.pdfPath })
      .from(filings)
      .where(
        and(
          inArray(filings.ticker, tickerList),
          eq(filings.status, "complete"),
        ),
      );
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
      const types: string[] = parseFilingTypesSafe(t.filingTypes);
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
      const types: string[] = parseFilingTypesSafe(t.filingTypes);
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

  // ─── Compare cache ────────────────────────────────────────
  //
  // The cache is keyed on (sorted accession pair, section). Section is
  // either a SectionKey for /api/compare or the sentinel "__whole__" for
  // whole-filing registration compares. Sorting normalizes (A,B) and
  // (B,A) to the same key so the user doesn't pay twice just because
  // the click order differed.

  async getCachedCompare(
    accessionA: string,
    accessionB: string,
    section: string,
  ): Promise<{ result: any; createdAt: string; costUsd: number } | null> {
    const [low, high] = accessionA <= accessionB ? [accessionA, accessionB] : [accessionB, accessionA];
    const rows = await db
      .select()
      .from(filingCompares)
      .where(
        and(
          eq(filingCompares.accessionLow, low),
          eq(filingCompares.accessionHigh, high),
          eq(filingCompares.section, section),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    try {
      return {
        result: JSON.parse(row.result),
        createdAt: row.createdAt,
        costUsd: row.costCents / 100,
      };
    } catch (err) {
      console.error(`Cached compare row ${row.id} has invalid JSON; ignoring:`, err);
      return null;
    }
  }

  async saveCachedCompare(opts: {
    accessionA: string;
    accessionB: string;
    section: string;
    result: any;
    costUsd: number;
    userId: number;
  }): Promise<void> {
    const [low, high] =
      opts.accessionA <= opts.accessionB
        ? [opts.accessionA, opts.accessionB]
        : [opts.accessionB, opts.accessionA];
    const costCents = Math.max(0, Math.round(opts.costUsd * 100));
    try {
      await db
        .insert(filingCompares)
        .values({
          accessionLow: low,
          accessionHigh: high,
          section: opts.section,
          result: JSON.stringify(opts.result),
          costCents,
          createdAt: new Date().toISOString(),
          userId: opts.userId,
        })
        .onConflictDoUpdate({
          target: [
            filingCompares.accessionLow,
            filingCompares.accessionHigh,
            filingCompares.section,
          ],
          set: {
            result: JSON.stringify(opts.result),
            costCents,
            createdAt: new Date().toISOString(),
            userId: opts.userId,
          },
        });
    } catch (err) {
      // Best-effort cache write — never let a cache failure break the
      // request the user is waiting on.
      console.error("Failed to save compare cache:", err);
    }
  }

  // Drop any cached compares referencing this accession on either side.
  // Called when a filing is queued for re-render, since the underlying
  // PDF text may differ and the cached changelog would be stale.
  async invalidateComparesForAccession(accession: string): Promise<void> {
    try {
      await db
        .delete(filingCompares)
        .where(
          or(
            eq(filingCompares.accessionLow, accession),
            eq(filingCompares.accessionHigh, accession),
          ),
        );
    } catch (err) {
      console.error(
        `Failed to invalidate compares for ${accession}:`,
        err,
      );
    }
  }
}

export const storage = new DatabaseStorage();
