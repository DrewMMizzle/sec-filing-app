import { storage } from "./storage";
import { startFetchRun } from "./routes";
import { isAdminEmail } from "./auth";

// ─── Nightly fetch ──────────────────────────────────────────
//
// Without this, new filings only arrive when somebody opens Fetch Filings and
// clicks. Nobody is going to do that daily across a 500-ticker watchlist, so
// in practice the corpus goes stale and the Findings page — the whole point of
// the app — stops having anything recent to show.
//
// Config, all optional:
//   NIGHTLY_FETCH_UTC_HOUR      0-23. UNSET DISABLES THE SCHEDULER.
//   NIGHTLY_FETCH_LOOKBACK_DAYS how far back to ask SEC for (default 3)
//   NIGHTLY_FETCH_LIMIT         max filings per ticker per run (default 5)
//
// Disabled-by-default is deliberate. A scheduled run spends real money on
// Claude review, so it should never switch itself on because the code shipped
// — someone has to opt in by setting the hour.

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min; the hour is the granularity
// UTC date of the last nightly run, persisted so restarts can't re-fire it.
const LAST_RUN_KEY = "scheduler_last_nightly_fetch_date";
const DEFAULT_LOOKBACK_DAYS = 3;
const DEFAULT_LIMIT_PER_TICKER = 5;

function scheduledHour(): number | null {
  const raw = (process.env.NIGHTLY_FETCH_UTC_HOUR || "").trim();
  if (!raw) return null;
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    console.warn(
      `[scheduler] NIGHTLY_FETCH_UTC_HOUR="${raw}" is not an integer 0-23 — the nightly ` +
        "fetch is DISABLED. Set it to the UTC hour you want the run to start.",
    );
    return null;
  }
  return hour;
}

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

// The account a scheduled run is attributed to. Prefer a configured admin so
// the run is owned by a real operator; fall back to the lowest user id. Filing
// rows need a userId, but the corpus is shared, so this carries no access
// meaning — it only affects who the run record says started it.
async function schedulerUserId(): Promise<number | undefined> {
  const emails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  for (const email of emails) {
    if (!isAdminEmail(email)) continue;
    const user = await storage.getUserByEmail(email);
    if (user) return user.id;
  }
  return storage.getFirstUserId();
}

export async function runNightlyFetch(): Promise<void> {
  const userId = await schedulerUserId();
  if (!userId) {
    console.warn("[scheduler] No user accounts exist yet — skipping the nightly fetch.");
    return;
  }

  const tickerList = await storage.getAllWatchlistTickersGlobal();
  if (tickerList.length === 0) {
    console.log("[scheduler] No tickers on any watchlist — nothing to fetch.");
    return;
  }

  const lookbackDays = envInt("NIGHTLY_FETCH_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS);
  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const run = await startFetchRun({
    kind: "fetch",
    userId,
    tickerList,
    dateFrom: ymd(from),
    dateTo: ymd(to),
    limitPerTicker: envInt("NIGHTLY_FETCH_LIMIT", DEFAULT_LIMIT_PER_TICKER),
    // Never sweep the backlog on a schedule — see startFetchRun. Only filings
    // that are genuinely new tonight get reviewed.
    queueBacklogReview: false,
  });

  if (!run) {
    // Someone is mid-fetch. Skipping is right: the single run slot exists
    // because two concurrent pipelines fight over SEC rate limits and disk.
    console.log("[scheduler] A run is already in progress — skipping tonight's fetch.");
    return;
  }

  console.log(
    `[scheduler] Nightly fetch started (run ${run.id}): ${tickerList.length} ticker(s), ` +
      `filed ${ymd(from)}..${ymd(to)}.`,
  );
}

export function startScheduler(): void {
  const hour = scheduledHour();
  if (hour === null) {
    console.log(
      "[scheduler] NIGHTLY_FETCH_UTC_HOUR is not set — no automatic fetch. Filings only " +
        "arrive when someone runs a fetch by hand. Set it to a UTC hour (0-23) to enable.",
    );
    return;
  }

  console.log(`[scheduler] Nightly fetch enabled at ${String(hour).padStart(2, "0")}:00 UTC.`);

  // Poll rather than compute a single long timeout: a setTimeout hours out
  // silently loses its schedule across a container restart, and Railway
  // restarts often.
  //
  // The "already ran today" marker lives in the settings table, not in a
  // variable, precisely because those restarts are frequent. With it in
  // memory, a restart at 03:30 after a 03:02 run would reset the guard, see
  // the hour still matching, and fire a second time — harmless money-wise
  // (dedup skips everything already rendered) but a full extra round of SEC
  // polling, one request per ticker, against a rate-limited API.
  //
  // Claiming is a single conditional upsert, so the claim and the check can't
  // interleave. `running` additionally stops two ticks overlapping if the DB
  // is slow, and the run slot in startFetchRun is the final backstop.
  let running = false;

  setInterval(() => {
    if (running) return;
    const now = new Date();
    if (now.getUTCHours() !== hour) return;

    running = true;
    void (async () => {
      try {
        const claimed = await storage.claimSettingOnce(LAST_RUN_KEY, ymd(now));
        if (claimed) await runNightlyFetch();
      } catch (err) {
        console.error("[scheduler] Nightly fetch failed:", err);
      } finally {
        running = false;
      }
    })();
  }, CHECK_INTERVAL_MS).unref();
}
