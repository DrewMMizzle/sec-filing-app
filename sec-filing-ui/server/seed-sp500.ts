import { db } from "./storage";
import { watchlists, tickers, users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { SP500_TICKERS } from "./data/sp500";

const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

export const SP500_WATCHLIST_NAME = "S&P 500";
const DEFAULT_FILING_TYPES = '["10-K","10-Q","8-K"]';

export type ResolvedTicker = { ticker: string; cik: string };

let resolveCache: Promise<ResolvedTicker[]> | null = null;

// Resolve the bundled S&P 500 symbols to CIKs via SEC's company_tickers.json.
// Cached for the process lifetime; a failed fetch clears the cache so the next
// caller retries rather than permanently caching the failure.
export function resolveSP500Tickers(): Promise<ResolvedTicker[]> {
  if (!resolveCache) {
    resolveCache = doResolve().catch((err) => {
      resolveCache = null;
      throw err;
    });
  }
  return resolveCache;
}

async function doResolve(): Promise<ResolvedTicker[]> {
  const response = await fetch(SEC_COMPANY_TICKERS_URL, {
    headers: { "User-Agent": SEC_USER_AGENT },
  });
  if (!response.ok) throw new Error(`SEC company_tickers returned ${response.status}`);
  const data = (await response.json()) as Record<string, { cik_str: number; ticker: string }>;

  const cikByTicker = new Map<string, string>();
  for (const entry of Object.values(data)) {
    if (entry.ticker) {
      cikByTicker.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
    }
  }

  const resolved: ResolvedTicker[] = [];
  const missing: string[] = [];
  for (const symbol of SP500_TICKERS) {
    const upper = symbol.toUpperCase();
    // SEC uses "-" where index lists use "." (e.g. BRK.B -> BRK-B).
    const variants = upper.includes(".") ? [upper.replace(/\./g, "-"), upper] : [upper];
    let found: ResolvedTicker | undefined;
    for (const v of variants) {
      const cik = cikByTicker.get(v);
      if (cik) {
        found = { ticker: v, cik };
        break;
      }
    }
    if (found) resolved.push(found);
    else missing.push(symbol);
  }

  if (missing.length > 0) {
    console.warn(`[sp500] Could not resolve ${missing.length} symbol(s) against SEC: ${missing.join(", ")}`);
  }
  return resolved;
}

// Create the "S&P 500" watchlist for a user if they don't already have one.
// Returns true if a watchlist was created. Idempotent by watchlist name.
export async function seedSP500ForUser(userId: number): Promise<boolean> {
  const existing = await db
    .select({ id: watchlists.id })
    .from(watchlists)
    .where(and(eq(watchlists.userId, userId), eq(watchlists.name, SP500_WATCHLIST_NAME)));
  if (existing.length > 0) return false;

  const resolved = await resolveSP500Tickers();

  const [wl] = await db
    .insert(watchlists)
    .values({ name: SP500_WATCHLIST_NAME, userId })
    .returning();

  if (resolved.length > 0) {
    await db.insert(tickers).values(
      resolved.map((r) => ({
        watchlistId: wl.id,
        ticker: r.ticker,
        cik: r.cik,
        filingTypes: DEFAULT_FILING_TYPES,
      })),
    );
  }
  return true;
}

// Seed the S&P 500 watchlist for every existing user that doesn't have one.
export async function backfillSP500(): Promise<void> {
  const allUsers = await db.select({ id: users.id }).from(users);
  if (allUsers.length === 0) return;

  let seeded = 0;
  for (const u of allUsers) {
    try {
      if (await seedSP500ForUser(u.id)) seeded++;
    } catch (err) {
      console.error(`[sp500] Failed to seed watchlist for user ${u.id}:`, err);
    }
  }
  if (seeded > 0) {
    console.log(`[sp500] Seeded S&P 500 watchlist for ${seeded} existing user(s)`);
  }
}
