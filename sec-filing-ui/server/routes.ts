import type { Express } from "express";
import type { Server } from "http";
import { storage, initDatabase, parseFilingTypesSafe } from "./storage";
import { insertWatchlistSchema } from "@shared/schema";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { hashPassword, verifyPassword, createSession, clearSession, requireAuth } from "./auth";
import { ensureSP500Seeded } from "./seed-sp500";
import { getSecTickerIndex } from "./sec-index";
import { isReviewEnabled, kickReviewProcessor, reviewCostUsd, requestCancelReview, isReviewProcessing } from "./review";
import { analyzeMdna, isMdnaEligible } from "./mdna";
import { lookupCikSubmissions, searchEdgarByName, nameToLabel } from "./sec-edgar";
import type { ChildProcess } from "child_process";

// Tracks the in-flight fetch/render pipeline child so a user cancel can kill
// it. Only one fetch runs at a time per process today (the route awaits it).
let currentFetchChild: ChildProcess | null = null;
import { chatAboutFindings, chatAboutFiling } from "./chat";
import { findPageForQuote } from "./pdf-locate";
import { compareFilings, SECTION_LABELS, type SectionKey } from "./compare";
import { db } from "./storage";
import { tickers as tickersTable, filings as filingsTable } from "@shared/schema";
import { eq } from "drizzle-orm";

const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || "DotAdda ameister@dotadda.com";

// Works in both ESM (dev via tsx) and CJS (prod via esbuild)
const __filename_compat = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const __dirname_compat = path.dirname(__filename_compat);
const PIPELINE_ROOT = process.env.PIPELINE_ROOT || path.resolve(__dirname_compat, "../../sec-pdf-pipeline");

// App-managed PDF storage directory
const PDF_STORAGE_DIR = process.env.PDF_STORAGE_DIR || path.resolve(__dirname_compat, "..", "pdfs");
if (!fs.existsSync(PDF_STORAGE_DIR)) {
  fs.mkdirSync(PDF_STORAGE_DIR, { recursive: true });
}

// Count stored PDFs so we can spot at startup whether a persistent volume is
// actually mounted (and populated) at PDF_STORAGE_DIR vs. ephemeral disk.
function countStoredPdfs(dir: string): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) n += countStoredPdfs(full);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) n += 1;
  }
  return n;
}

// One-line startup diagnostic visible in deploy logs.
(() => {
  let writable = false;
  try {
    const probe = path.join(PDF_STORAGE_DIR, ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  console.log(
    `[storage] PDF_STORAGE_DIR=${PDF_STORAGE_DIR} exists=${fs.existsSync(PDF_STORAGE_DIR)} ` +
      `writable=${writable} storedPdfs=${countStoredPdfs(PDF_STORAGE_DIR)}`,
  );
})();

// Whether a filing's rendered PDF actually exists on disk. The DB row can say
// "complete" while the file is gone (e.g. ephemeral storage wiped on redeploy),
// so callers verify the file before treating a filing as available.
function pdfExistsOnDisk(pdfPath: string | null | undefined): boolean {
  if (!pdfPath) return false;
  const appPath = path.resolve(PDF_STORAGE_DIR, "..", pdfPath);
  const pipelinePath = path.join(PIPELINE_ROOT, pdfPath);
  return fs.existsSync(appPath) || fs.existsSync(pipelinePath);
}

type PipelineResult = {
  success: boolean;
  events: any[];
  completedAccessions: string[];
  doneEvent?: any;
  error?: string;
};

// Spawn the Python fetch/render pipeline with the given JSON input, persisting
// rendered PDFs + filing rows. Resolves when the process exits. Shared by the
// fetch and re-render-missing endpoints.
function runFetchPipeline(
  input: string,
  ctx: { userId: number; cikByTicker: Map<string, string> },
): Promise<PipelineResult> {
  return new Promise((resolve) => {
    const pythonScript = path.join(PIPELINE_ROOT, "scripts", "fetch_filings.py");
    if (!fs.existsSync(pythonScript)) {
      resolve({ success: false, events: [], completedAccessions: [], error: "Pipeline script not found." });
      return;
    }
    const child = spawn("python3", [pythonScript], {
      cwd: PIPELINE_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    currentFetchChild = child;
    child.stdin.write(input);
    child.stdin.end();

    const events: any[] = [];
    const completedAccessions: string[] = [];
    let stderrOutput = "";
    let settled = false;

    // Watchdog: if the pipeline produces no output for this long, treat it as
    // stalled (e.g. a wedged Chromium) and kill it so the run can't hang
    // forever. Anything rendered/reviewed before the stall is already saved, and
    // a re-fetch resumes (dedup skips completed filings). The budget covers
    // one legal attempt's silent window: preprocess (4 min cap) +
    // page.pdf() (5 min cap), with margin — Python's logger also writes to
    // stderr, which we now treat as activity, so a healthy run never gets
    // close to this.
    const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
    let lastActivity = Date.now();
    let stalled = false;
    const watchdog = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        stalled = true;
        console.error(
          `[pipeline] No output for ${IDLE_TIMEOUT_MS / 1000}s — stopping stalled pipeline.`,
        );
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 30_000);

    child.stdout.on("data", (data: Buffer) => {
      lastActivity = Date.now();
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          events.push(event);
          if (event.event === "rendering") {
            storage
              .upsertFiling({
                ticker: event.ticker,
                cik: ctx.cikByTicker.get(event.ticker) || "",
                accessionNumber: event.accession,
                filingType: event.filing_type,
                filingDate: event.filing_date || null,
                status: "rendering",
                createdAt: new Date().toISOString(),
                userId: ctx.userId,
              })
              .catch((err) => console.error("Failed to upsert filing:", err));
          } else if (event.event === "complete") {
            const pipelinePdf = path.join(PIPELINE_ROOT, event.path);
            const ticker = event.ticker || "UNKNOWN";
            const safeType = (event.filing_type || "filing").replace(/ /g, "_");
            const destDir = path.join(PDF_STORAGE_DIR, ticker, safeType);
            const destFile = path.join(destDir, `${event.accession}.pdf`);
            const appRelPath = path.relative(path.resolve(PDF_STORAGE_DIR, ".."), destFile);
            completedAccessions.push(event.accession);
            // Async fs + DB so a 10-K-sized copy doesn't stall the event loop
            // and starve other API requests / event handling. Order within the
            // chain is preserved (mkdir → copy → DB update → queue review).
            (async () => {
              try {
                await fs.promises.mkdir(destDir, { recursive: true });
                await fs.promises.copyFile(pipelinePdf, destFile);
              } catch (copyErr) {
                console.error(`Failed to copy PDF to app storage: ${copyErr}`);
              }
              try {
                await storage.updateFilingStatus(
                  event.accession,
                  "complete",
                  appRelPath,
                  event.size,
                );
                if (isReviewEnabled()) {
                  // Queue the review as soon as the PDF is rendered (and nudge
                  // the processor) so spend and review progress move during
                  // the run, instead of only after the entire batch finishes.
                  await storage.markFilingForReview(event.accession);
                  kickReviewProcessor().catch((err) =>
                    console.error("Review processor failed:", err),
                  );
                }
              } catch (err) {
                console.error("Failed to update filing status:", err);
              }
            })();
          } else if (event.event === "error" && event.accession) {
            storage
              .updateFilingStatus(event.accession, "error", undefined, undefined, event.message)
              .catch((err) => console.error("Failed to update filing error:", err));
          }
        } catch {
          // non-JSON line from Python logging
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      // Python's `logger.info`/`logger.debug` writes here by default. Counting
      // stderr as activity prevents the watchdog from killing a render that's
      // chattily making progress on the Python side but happens not to have
      // emitted a stdout JSON event yet (preprocess + page.pdf can be silent
      // on stdout for several minutes per filing).
      lastActivity = Date.now();
      stderrOutput += data.toString();
    });

    child.on("close", (code) => {
      if (currentFetchChild === child) currentFetchChild = null;
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      const doneEvent = events.find((e) => e.event === "done");
      if (stalled) {
        resolve({
          success: false,
          events,
          completedAccessions,
          error: `Pipeline stalled (no output for ${IDLE_TIMEOUT_MS / 60000} min) and was stopped after rendering ${completedAccessions.length} filing(s). Run it again to resume.`,
        });
      } else if (code === 0 && doneEvent) {
        resolve({ success: true, events, completedAccessions, doneEvent });
      } else {
        resolve({ success: false, events, completedAccessions, error: stderrOutput || "Pipeline process failed" });
      }
    });

    child.on("error", (err) => {
      if (currentFetchChild === child) currentFetchChild = null;
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve({ success: false, events, completedAccessions, error: `Failed to start pipeline: ${err.message}` });
    });
  });
}

// Helper: check if user has access to a watchlist (owner or shared)
async function checkWatchlistAccess(watchlistId: number, userId: number): Promise<{ access: "owner" | "edit" | "view" | null; watchlist: any }> {
  const wl = await storage.getWatchlist(watchlistId);
  if (!wl) return { access: null, watchlist: null };

  if (wl.userId === userId) return { access: "owner", watchlist: wl };

  const share = await storage.getShareForUser(watchlistId, userId);
  if (share) return { access: share.permission as "edit" | "view", watchlist: wl };

  return { access: null, watchlist: wl };
}

export async function registerRoutes(server: Server, app: Express): Promise<void> {
  // Initialize database tables + indexes
  await initDatabase();

  // Recover filings left mid-render by a prior crash/stall so the UI doesn't
  // spin on them forever. Safe at boot: no render is in flight yet.
  storage
    .recoverStaleRenders()
    .then((n) => n > 0 && console.log(`[startup] Reset ${n} stale 'rendering' filing(s) to error.`))
    .catch((err) => console.error("Stale-render recovery failed:", err));

  // ─── Health check (public, unauthenticated) ─────────────
  // Used by Railway's deploy probe, which sends no auth cookie. Must stay
  // outside requireAuth so it returns 200 instead of 401.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // ─── Auth Routes ────────────────────────────────────────

  app.post("/api/auth/register", async (req, res) => {
    const { email, password, displayName } = req.body;

    if (!email || !password || !displayName) {
      return res.status(400).json({ error: "email, password, and displayName are required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = await storage.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await hashPassword(password);
    const user = await storage.createUser({
      email: email.trim().toLowerCase(),
      passwordHash,
      displayName: displayName.trim(),
      createdAt: new Date().toISOString(),
    });

    await createSession(res, user.id);

    // Pre-load the S&P 500 watchlist so new users start with a usable list.
    // ensureSP500Seeded never throws, so it can't block account creation.
    await ensureSP500Seeded(user.id);

    // Clean up expired sessions in background
    storage.deleteExpiredSessions().catch(() => {});

    res.status(201).json({ id: user.id, email: user.email, displayName: user.displayName });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await storage.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    await createSession(res, user.id);

    // Clean up expired sessions in background
    storage.deleteExpiredSessions().catch(() => {});

    res.json({ id: user.id, email: user.email, displayName: user.displayName });
  });

  app.post("/api/auth/logout", async (req, res) => {
    await clearSession(req, res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json(req.user);
  });

  // ─── All remaining routes require auth ──────────────────

  // ─── Watchlists ──────────────────────────────────────────

  app.get("/api/watchlists", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    // Self-heal: ensure the user has their pre-loaded S&P 500 list, so existing
    // users get it on their next visit without needing a restart or re-login.
    await ensureSP500Seeded(userId);
    const lists = await storage.getWatchlists(userId);
    const result = await Promise.all(
      lists.map(async (wl) => ({
        ...wl,
        tickerCount: (await storage.getTickersByWatchlist(wl.id)).length,
      })),
    );
    res.json(result);
  });

  app.get("/api/watchlists/shared", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const shared = await storage.getSharedWatchlists(userId);
    const result = await Promise.all(
      shared.map(async (wl) => ({
        ...wl,
        tickerCount: (await storage.getTickersByWatchlist(wl.id)).length,
      })),
    );
    res.json(result);
  });

  app.get("/api/watchlists/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    const { access, watchlist: wl } = await checkWatchlistAccess(id, userId);

    if (!wl) return res.status(404).json({ error: "Watchlist not found" });
    if (!access) return res.status(403).json({ error: "Access denied" });

    const tickerRows = await storage.getTickersByWatchlist(id);
    const tickers = tickerRows.map((t) => ({
      ...t,
      filingTypes: parseFilingTypesSafe(t.filingTypes),
    }));
    let ownerName: string | undefined;
    if (access !== "owner") {
      const owner = await storage.getUserById(wl.userId);
      ownerName = owner?.displayName;
    }
    res.json({ ...wl, tickers, access, ownerName });
  });

  app.post("/api/watchlists", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const parsed = insertWatchlistSchema.safeParse({ ...req.body, userId });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const wl = await storage.createWatchlist(parsed.data);
      res.status(201).json(wl);
    } catch (e: any) {
      if (e.message?.includes("unique") || e.message?.includes("duplicate")) {
        return res.status(409).json({ error: "A watchlist with that name already exists" });
      }
      throw e;
    }
  });

  app.patch("/api/watchlists/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(id, userId);

    if (!access) return res.status(404).json({ error: "Watchlist not found" });
    if (access !== "owner") return res.status(403).json({ error: "Only the owner can rename a watchlist" });

    const { name } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const updated = await storage.renameWatchlist(id, name.trim());
    if (!updated) return res.status(404).json({ error: "Watchlist not found" });
    res.json(updated);
  });

  app.delete("/api/watchlists/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(id, userId);

    if (!access) return res.status(404).json({ error: "Watchlist not found" });
    if (access !== "owner") return res.status(403).json({ error: "Only the owner can delete a watchlist" });

    await storage.deleteWatchlist(id);
    res.status(204).send();
  });

  // ─── Sharing ────────────────────────────────────────────

  app.get("/api/watchlists/:id/shares", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(id, userId);

    if (!access) return res.status(404).json({ error: "Watchlist not found" });
    if (access !== "owner") return res.status(403).json({ error: "Only the owner can view shares" });

    const shares = await storage.getWatchlistShares(id);
    res.json(shares);
  });

  app.post("/api/watchlists/:id/share", requireAuth, async (req, res) => {
    const watchlistId = Number(req.params.id);
    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(watchlistId, userId);

    if (!access) return res.status(404).json({ error: "Watchlist not found" });
    if (access !== "owner") return res.status(403).json({ error: "Only the owner can share a watchlist" });

    const { email, permission } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });
    if (permission && !["view", "edit"].includes(permission)) {
      return res.status(400).json({ error: "permission must be 'view' or 'edit'" });
    }

    const targetUser = await storage.getUserByEmail(email);
    if (!targetUser) return res.status(404).json({ error: "No user found with that email" });
    if (targetUser.id === userId) return res.status(400).json({ error: "Cannot share with yourself" });

    // Check if already shared
    const existing = await storage.getShareForUser(watchlistId, targetUser.id);
    if (existing) return res.status(409).json({ error: "Already shared with this user" });

    const share = await storage.createShare({
      watchlistId,
      sharedWithUserId: targetUser.id,
      permission: permission || "view",
      createdAt: new Date().toISOString(),
    });
    res.status(201).json(share);
  });

  app.delete("/api/watchlists/:id/share/:userId", requireAuth, async (req, res) => {
    const watchlistId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(watchlistId, userId);

    if (!access) return res.status(404).json({ error: "Watchlist not found" });

    // Owner can remove anyone; shared user can remove themselves
    if (access !== "owner" && targetUserId !== userId) {
      return res.status(403).json({ error: "Only the owner can remove other users' shares" });
    }

    await storage.deleteShare(watchlistId, targetUserId);
    res.status(204).send();
  });

  // ─── Tickers ─────────────────────────────────────────────

  app.get("/api/watchlists/:id/tickers", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    const { access, watchlist: wl } = await checkWatchlistAccess(id, userId);

    if (!wl) return res.status(404).json({ error: "Watchlist not found" });
    if (!access) return res.status(403).json({ error: "Access denied" });

    const tickerRows = await storage.getTickersByWatchlist(id);
    const result = tickerRows.map((t) => ({
      ...t,
      filingTypes: parseFilingTypesSafe(t.filingTypes),
    }));
    res.json(result);
  });

  app.post("/api/watchlists/:id/tickers", requireAuth, async (req, res) => {
    const watchlistId = Number(req.params.id);
    const userId = req.user!.id;
    const { access, watchlist: wl } = await checkWatchlistAccess(watchlistId, userId);

    if (!wl) return res.status(404).json({ error: "Watchlist not found" });
    if (!access) return res.status(403).json({ error: "Access denied" });
    if (access === "view") return res.status(403).json({ error: "View-only access cannot add tickers" });

    const { ticker, cik: bodyCik, label, filingTypes } = req.body as {
      ticker?: unknown;
      cik?: unknown;
      label?: unknown;
      filingTypes?: unknown;
    };

    // Pre-IPO path: client supplies a CIK directly (with an optional display
    // label) because the company has no ticker yet.
    if (typeof bodyCik === "string" && bodyCik.trim()) {
      const sub = await lookupCikSubmissions(bodyCik);
      if (!sub) return res.status(404).json({ error: `CIK "${bodyCik}" not found at SEC` });
      const labelStr = typeof label === "string" ? label.trim().toUpperCase() : "";
      const tickerLabel = (labelStr || sub.tickers[0] || nameToLabel(sub.name)).slice(0, 32);
      const types = Array.isArray(filingTypes) && filingTypes.length > 0
        ? filingTypes
        : ["S-1", "S-1/A", "10-K", "10-Q", "8-K", "DEF 14A"];
      const newTicker = await storage.addTicker({
        watchlistId,
        ticker: tickerLabel,
        cik: sub.cik,
        filingTypes: JSON.stringify(types),
      });
      return res.status(201).json({ ...newTicker, filingTypes: types, companyName: sub.name });
    }

    if (!ticker || typeof ticker !== "string") {
      return res.status(400).json({ error: "ticker or cik is required" });
    }

    try {
      const response = await fetch(SEC_COMPANY_TICKERS_URL, {
        headers: { "User-Agent": SEC_USER_AGENT },
      });
      if (!response.ok) throw new Error(`SEC API returned ${response.status}`);
      const data = (await response.json()) as Record<string, { cik_str: number; ticker: string }>;

      const tickerUpper = ticker.toUpperCase().trim();
      let cik: string | null = null;
      let officialTicker: string = tickerUpper;

      for (const entry of Object.values(data)) {
        if (entry.ticker?.toUpperCase() === tickerUpper) {
          cik = String(entry.cik_str).padStart(10, "0");
          officialTicker = entry.ticker;
          break;
        }
      }

      if (!cik) {
        return res.status(404).json({ error: `Ticker "${ticker}" not found in SEC database` });
      }

      const types = Array.isArray(filingTypes) && filingTypes.length > 0
        ? filingTypes
        : ["10-K", "10-Q", "8-K", "DEF 14A"];

      const newTicker = await storage.addTicker({
        watchlistId,
        ticker: officialTicker,
        cik,
        filingTypes: JSON.stringify(types),
      });

      res.status(201).json({
        ...newTicker,
        filingTypes: types,
      });
    } catch (e: any) {
      console.error("Error resolving ticker:", e);
      res.status(500).json({ error: "Failed to resolve ticker with SEC" });
    }
  });

  // Add several already-resolved tickers (ticker + cik) to a watchlist in one
  // call, skipping any the watchlist already has. Used by Quick Fetch, which
  // has already resolved CIKs via /api/resolve-tickers — so unlike the single
  // endpoint above this trusts the supplied cik and never re-downloads SEC's
  // full company-tickers file.
  app.post("/api/watchlists/:id/tickers/bulk", requireAuth, async (req, res) => {
    const watchlistId = Number(req.params.id);
    const userId = req.user!.id;
    const { access, watchlist: wl } = await checkWatchlistAccess(watchlistId, userId);

    if (!wl) return res.status(404).json({ error: "Watchlist not found" });
    if (!access) return res.status(403).json({ error: "Access denied" });
    if (access === "view") return res.status(403).json({ error: "View-only access cannot add tickers" });

    const { tickers: incoming, filingTypes: incomingTypes } = req.body as {
      tickers?: Array<{ ticker?: unknown; cik?: unknown }>;
      filingTypes?: unknown;
    };
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: "tickers array is required" });
    }
    // Persist the same forms the caller is fetching, defaulting to a broader
    // list that includes S-1 / S-1/A so a pre-IPO entry doesn't immediately
    // come back empty on the next fetch.
    const filingTypes =
      Array.isArray(incomingTypes) && incomingTypes.length > 0
        ? (incomingTypes as unknown[]).filter((t): t is string => typeof t === "string")
        : ["10-K", "10-Q", "8-K", "DEF 14A", "S-1", "S-1/A"];

    const existing = await storage.getTickersByWatchlist(watchlistId);
    const have = new Set(existing.map((t) => t.ticker.toUpperCase()));

    let added = 0;
    let skipped = 0;
    for (const row of incoming) {
      const ticker = typeof row?.ticker === "string" ? row.ticker.toUpperCase().trim() : "";
      const cik = typeof row?.cik === "string" ? row.cik.trim() : "";
      if (!ticker || !cik) continue;
      if (have.has(ticker)) {
        skipped += 1;
        continue;
      }
      await storage.addTicker({
        watchlistId,
        ticker,
        cik,
        filingTypes: JSON.stringify(filingTypes),
      });
      have.add(ticker);
      added += 1;
    }

    res.status(201).json({ added, skipped });
  });

  app.delete("/api/tickers/:id", requireAuth, async (req, res) => {
    // We need to verify the ticker belongs to a watchlist the user owns or has edit access to
    const id = Number(req.params.id);
    const tickerRows = await db.select().from(tickersTable).where(eq(tickersTable.id, id));
    const ticker = tickerRows[0];
    if (!ticker) return res.status(404).json({ error: "Ticker not found" });

    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(ticker.watchlistId, userId);
    if (!access) return res.status(403).json({ error: "Access denied" });
    if (access === "view") return res.status(403).json({ error: "View-only access cannot remove tickers" });

    await storage.removeTicker(id);
    res.status(204).send();
  });

  app.patch("/api/tickers/:id/filing-types", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const patchTickerRows = await db.select().from(tickersTable).where(eq(tickersTable.id, id));
    const patchTicker = patchTickerRows[0];
    if (!patchTicker) return res.status(404).json({ error: "Ticker not found" });

    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(patchTicker.watchlistId, userId);
    if (!access) return res.status(403).json({ error: "Access denied" });
    if (access === "view") return res.status(403).json({ error: "View-only access" });

    const { filingTypes } = req.body;
    if (!Array.isArray(filingTypes)) {
      return res.status(400).json({ error: "filingTypes must be an array" });
    }
    const updated = await storage.updateTickerFilingTypes(id, JSON.stringify(filingTypes));
    if (!updated) return res.status(404).json({ error: "Ticker not found" });
    res.json({ ...updated, filingTypes });
  });

  // Rename a ticker's display label — used when a pre-IPO company's "ticker"
  // is initially a name-derived placeholder and the user wants to update it
  // to the real symbol post-IPO (or just clean it up).
  app.patch("/api/tickers/:id/symbol", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const rows = await db.select().from(tickersTable).where(eq(tickersTable.id, id));
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: "Ticker not found" });

    const userId = req.user!.id;
    const { access } = await checkWatchlistAccess(existing.watchlistId, userId);
    if (!access) return res.status(403).json({ error: "Access denied" });
    if (access === "view") return res.status(403).json({ error: "View-only access" });

    const symbol =
      typeof req.body?.symbol === "string" ? req.body.symbol.trim().toUpperCase() : "";
    if (!symbol) return res.status(400).json({ error: "symbol is required" });
    if (symbol.length > 32) return res.status(400).json({ error: "symbol is too long" });

    const updated = await storage.updateTickerSymbol(id, symbol);
    if (!updated) return res.status(404).json({ error: "Ticker not found" });
    res.json(updated);
  });

  // ─── Export watchlist.json ───────────────────────────────

  app.get("/api/export-watchlist", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const data = await storage.exportWatchlistJson(userId);
    res.json(data);
  });

  // ─── All unique tickers across watchlists ────────────────

  app.get("/api/all-tickers", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const data = await storage.getAllTickers(userId);
    res.json(data);
  });

  // Resolve a raw list of ticker symbols against SEC's company_tickers.json so
  // the Quick fetch flow on Fetch & Review can skip the watchlist step. Returns
  // resolved {ticker, cik, name} plus any unresolved input symbols so the UI
  // can surface them to the user.
  app.post("/api/resolve-tickers", requireAuth, async (req, res) => {
    const { tickers } = req.body as { tickers?: unknown };
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ error: "tickers array is required" });
    }
    try {
      const idx = await getSecTickerIndex();
      const resolved: Array<{ ticker: string; cik: string; name: string }> = [];
      const unresolved: string[] = [];
      // Inputs that look like company names (or misspellings) — anything alpha
      // that didn't match a ticker — get a fallback EDGAR name search at the
      // end so pre-IPO filers like SpaceX are reachable from Quick Fetch.
      const alphaMisses: Array<{ query: string; original: string }> = [];
      const seen = new Set<string>();
      const inputs = (tickers as unknown[])
        .filter((t): t is string => typeof t === "string")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const original of inputs) {
        const symbol = original.toUpperCase();
        // Numeric input → CIK (pre-IPO companies have a CIK but no ticker).
        // Look it up via SEC's submissions JSON to get the company name and
        // any tickers, then build a resolved entry with either the SEC ticker
        // or a name-derived display label.
        if (/^\d+$/.test(symbol)) {
          const sub = await lookupCikSubmissions(symbol);
          if (sub) {
            const label = (sub.tickers[0] ?? nameToLabel(sub.name)).toUpperCase();
            if (!seen.has(label)) {
              seen.add(label);
              resolved.push({ ticker: label, cik: sub.cik, name: sub.name });
            }
            continue;
          }
          unresolved.push(symbol);
          continue;
        }
        // SEC uses "-" where index lists use "." (e.g. BRK.B -> BRK-B).
        const variants = symbol.includes(".") ? [symbol.replace(/\./g, "-"), symbol] : [symbol];
        let hit: { ticker: string; cik: string; name: string } | null = null;
        for (const v of variants) {
          const entry = idx.get(v);
          if (entry) {
            hit = { ticker: v, cik: entry.cik, name: entry.name };
            break;
          }
        }
        if (hit) {
          if (!seen.has(hit.ticker)) {
            seen.add(hit.ticker);
            resolved.push(hit);
          }
        } else {
          alphaMisses.push({ query: symbol, original });
        }
      }

      // EDGAR name-search fallback for alpha misses. Run in parallel so a
      // multi-name Quick Fetch isn't bottlenecked by sequential HTTP calls.
      const ambiguous: Array<{
        query: string;
        candidates: Array<{ cik: string; name: string; ticker?: string }>;
      }> = [];
      if (alphaMisses.length > 0) {
        const searches = await Promise.all(
          alphaMisses.map(async (miss) => {
            try {
              const candidates = await searchEdgarByName(miss.original);
              return { miss, candidates };
            } catch {
              return { miss, candidates: [] as Array<{ cik: string; name: string; ticker?: string }> };
            }
          }),
        );
        for (const { miss, candidates } of searches) {
          if (candidates.length === 0) {
            unresolved.push(miss.query);
            continue;
          }
          if (candidates.length === 1) {
            const c = candidates[0];
            const label = (c.ticker ?? nameToLabel(c.name)).toUpperCase();
            if (!seen.has(label)) {
              seen.add(label);
              resolved.push({ ticker: label, cik: c.cik, name: c.name });
            }
            continue;
          }
          ambiguous.push({ query: miss.original, candidates });
        }
      }

      res.json({ resolved, unresolved, ambiguous });
    } catch (e: any) {
      console.error("Error resolving tickers:", e);
      res.status(500).json({ error: "Failed to resolve tickers with SEC" });
    }
  });

  // Search SEC EDGAR by company name so users can find pre-IPO companies
  // (which have a CIK but no ticker and are NOT in company_tickers.json).
  // Returns at most 10 deduped {cik, name, ticker?} matches.
  app.get("/api/edgar/search", requireAuth, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q.trim()) return res.json([]);
    try {
      const results = await searchEdgarByName(q);
      res.json(results);
    } catch (e: any) {
      console.error("EDGAR search failed:", e?.message || e);
      res.status(502).json({ error: "EDGAR search failed" });
    }
  });

  // ─── Filings: list, stats, fetch, download, manage ────────

  // Filing stats summary (must come before /:accession routes)
  app.get("/api/filings/stats", requireAuth, async (_req, res) => {
    const stats = await storage.getFilingStats();
    res.json(stats);
  });

  // Constant-size progress poll — both pages use this to detect run activity +
  // changes without re-fetching the full filings list. lastReviewedAt advances
  // each time a new review lands, so the client can lazily refetch row data
  // only when there's actually something new to show.
  app.get("/api/filings/progress", requireAuth, async (_req, res) => {
    const progress = await storage.getFilingsProgress();
    res.json(progress);
  });

  // Paginated/filterable/sortable filings — push filter/sort/pagination to SQL
  // so the client doesn't ship the whole corpus over the wire to render a page.
  app.get("/api/filings/page", requireAuth, async (req, res) => {
    const num = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const q = req.query as Record<string, string | undefined>;
    const limit = num(q.limit) ?? 50;
    const offset = num(q.offset) ?? 0;
    const result = await storage.getFilingsPage({
      ticker: q.ticker,
      filingType: q.filingType,
      status: q.status,
      reviewStatus: q.reviewStatus,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      q: q.q,
      sort: q.sort,
      dir: q.dir === "asc" ? "asc" : "desc",
      limit,
      offset,
      slim: q.slim === "true" || q.slim === "1",
    });
    res.json({ items: result.items, total: result.total, limit, offset });
  });

  app.get("/api/filings", requireAuth, async (req, res) => {
    const { ticker, filingType, dateFrom, dateTo, status, slim } = req.query as Record<
      string,
      string | undefined
    >;
    const results = await storage.getFilings({
      ticker,
      filingType,
      dateFrom,
      dateTo,
      status,
      slim: slim === "true" || slim === "1",
    });
    res.json(results);
  });

  // Trigger fetch+render for selected tickers + date range
  app.post("/api/filings/fetch", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const { tickers: tickerList, dateFrom, dateTo, limitPerTicker } = req.body as {
      tickers: Array<{ ticker: string; cik: string; filing_types: string[] }>;
      dateFrom?: string;
      dateTo?: string;
      limitPerTicker?: number;
    };

    if (!tickerList || tickerList.length === 0) {
      return res.status(400).json({ error: "tickers array is required" });
    }

    // ── Dedup: skip filings already complete AND whose PDF still exists on disk.
    // (A redeploy can wipe ephemeral PDF storage while the DB row persists, so a
    // status check alone would wrongly skip filings that need re-rendering.) ──
    const tickerNames = tickerList.map((t) => t.ticker);
    const completeRows = await storage.getCompleteFilings(tickerNames);
    const alreadyComplete = new Set(
      completeRows.filter((r) => pdfExistsOnDisk(r.pdfPath)).map((r) => r.accessionNumber),
    );

    const input = JSON.stringify({
      tickers: tickerList,
      date_from: dateFrom || null,
      date_to: dateTo || null,
      limit_per_ticker: limitPerTicker || 10,
      skip_accessions: Array.from(alreadyComplete),
    });

    const cikByTicker = new Map(tickerList.map((t) => [t.ticker, t.cik]));
    const result = await runFetchPipeline(input, { userId, cikByTicker });
    // Always sweep stale 'rendering' rows for the tickers we touched —
    // regardless of pipeline success. A failed/killed pipeline would
    // otherwise leave rows spinning forever, which is exactly what made
    // the SpaceX S-1/A look stuck on "Rendering" after a watchdog kill.
    storage
      .recoverStaleRenders(tickerNames)
      .catch((err) => console.error("Stale-render recovery failed:", err));
    if (!result.success) {
      return res
        .status(500)
        .json({ success: false, error: result.error || "Pipeline process failed", events: result.events });
    }
    res.json({
      success: true,
      totalRendered: result.doneEvent?.total_rendered ?? 0,
      totalSkipped: result.doneEvent?.total_skipped ?? 0,
      totalErrors: result.doneEvent?.total_errors ?? 0,
      events: result.events,
    });

    // Newly-rendered filings were queued incrementally as each PDF landed. Also
    // queue any already-rendered filings (skipped by dedup) that were never
    // reviewed, so a re-fetch reviews the whole outstanding backlog for these
    // tickers — not just the brand-new filings.
    if (isReviewEnabled()) {
      storage
        .markCompleteFilingsForReviewByTickers(tickerNames)
        .then(() => kickReviewProcessor())
        .catch((err) => console.error("Review processor failed:", err));
    }
  });

  // Re-render filings that are "complete" in the DB but whose PDF is missing
  // on disk (e.g. wiped before the persistent volume existed). Processes a
  // bounded number of tickers per call; returns how many remain.
  app.post("/api/filings/render-missing", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const TICKER_CAP = 20;

    const complete = await storage.getFilings({ status: "complete" });
    const missing = complete.filter((f) => !pdfExistsOnDisk(f.pdfPath));
    if (missing.length === 0) {
      return res.json({ rerendered: 0, missingTotal: 0, tickersRemaining: 0 });
    }

    // Group missing filings by ticker
    const byTicker = new Map<string, typeof missing>();
    for (const f of missing) {
      const arr = byTicker.get(f.ticker);
      if (arr) arr.push(f);
      else byTicker.set(f.ticker, [f]);
    }
    const allTickers = Array.from(byTicker.keys());
    const batchTickers = allTickers.slice(0, TICKER_CAP);

    const cikByTicker = new Map<string, string>();
    const tickers: Array<{ ticker: string; cik: string; filing_types: string[] }> = [];
    let minDate = "9999-99-99";
    let maxDate = "0000-00-00";
    for (const t of batchTickers) {
      const rows = byTicker.get(t)!;
      const cik = rows.find((r) => r.cik)?.cik || "";
      cikByTicker.set(t, cik);
      tickers.push({ ticker: t, cik, filing_types: Array.from(new Set(rows.map((r) => r.filingType))) });
      for (const r of rows) {
        if (r.filingDate) {
          if (r.filingDate < minDate) minDate = r.filingDate;
          if (r.filingDate > maxDate) maxDate = r.filingDate;
        }
      }
    }

    // Skip filings that already have a PDF on disk so we only re-render missing ones.
    const present = complete.filter((f) => pdfExistsOnDisk(f.pdfPath)).map((f) => f.accessionNumber);
    const input = JSON.stringify({
      tickers,
      date_from: minDate === "9999-99-99" ? null : minDate,
      date_to: maxDate === "0000-00-00" ? null : maxDate,
      limit_per_ticker: 100,
      skip_accessions: present,
    });

    const result = await runFetchPipeline(input, { userId, cikByTicker });
    if (!result.success) {
      return res.status(500).json({ error: result.error || "Re-render failed" });
    }
    // Reviews are queued incrementally as each PDF re-renders; final nudge only.
    if (isReviewEnabled() && result.completedAccessions.length > 0) {
      kickReviewProcessor().catch((err) => console.error("Review processor failed:", err));
    }
    res.json({
      rerendered: result.completedAccessions.length,
      missingTotal: missing.length,
      tickersRemaining: Math.max(0, allTickers.length - batchTickers.length),
    });
  });

  // Whether Claude review is configured, so the UI can show the right state
  app.get("/api/config", requireAuth, (_req, res) => {
    res.json({ reviewEnabled: isReviewEnabled() });
  });

  // Actual Claude spend so far, from recorded per-filing token usage, plus the
  // team spend cap (if any) and whether the review queue is currently paused
  // because that cap has been hit.
  app.get("/api/review/usage", requireAuth, async (_req, res) => {
    const u = await storage.getReviewUsage();
    const rawCost = reviewCostUsd(u);
    const costUsd = Math.round(rawCost * 100) / 100;
    const budgetUsd = await storage.getReviewBudgetUsd();
    const pendingCount = await storage.getPendingReviewCount();
    const paused = budgetUsd !== null && rawCost >= budgetUsd && pendingCount > 0;
    const processing = isReviewProcessing();
    const fetching = currentFetchChild !== null;
    res.json({ ...u, costUsd, budgetUsd, pendingCount, paused, processing, fetching });
  });

  // Cancel an in-flight fetch+render+review run. Kills the Python pipeline
  // child if one is running, aborts the in-flight Claude review API call, and
  // drops any still-queued filings back to "not requested" so the next kick
  // doesn't pick them up automatically.
  app.post("/api/run/cancel", requireAuth, async (_req, res) => {
    let fetchKilled = false;
    if (currentFetchChild) {
      const child = currentFetchChild;
      try {
        child.kill("SIGTERM");
        // Escalate if the child doesn't exit promptly on its own.
        setTimeout(() => {
          if (!child.killed) {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, 3000);
        fetchKilled = true;
      } catch (err: any) {
        console.error("[cancel] Failed to signal fetch child:", err?.message || err);
      }
    }
    const { abortedInFlight } = requestCancelReview();
    const pendingCleared = await storage.clearPendingReviews();
    res.json({ ok: true, fetchKilled, abortedInFlight, pendingCleared });
  });

  // Set or clear the team-wide review spend cap (USD). Pass null/empty to clear.
  // Applies only to the fetch+review pipeline, never to Compare.
  app.post("/api/review/budget", requireAuth, async (req, res) => {
    const { budgetUsd } = req.body as { budgetUsd?: number | null };
    if (budgetUsd === null || budgetUsd === undefined || budgetUsd === ("" as any)) {
      await storage.setSetting("review_budget_usd", null);
      return res.json({ budgetUsd: null });
    }
    const n = Number(budgetUsd);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: "budgetUsd must be a non-negative number or null" });
    }
    await storage.setSetting("review_budget_usd", String(n));
    // Raising the cap may unpause a stalled queue — give it a nudge.
    kickReviewProcessor().catch((err) => console.error("Review processor failed:", err));
    res.json({ budgetUsd: n });
  });

  // Compare a section (e.g. Risk Factors) between two filings of the same company
  app.post("/api/compare", requireAuth, async (req, res) => {
    if (!isReviewEnabled()) {
      return res
        .status(409)
        .json({ error: "Claude review is not configured (ANTHROPIC_API_KEY is not set)." });
    }
    const { accessionA, accessionB, section } = req.body as {
      accessionA?: string;
      accessionB?: string;
      section?: string;
    };
    if (!accessionA || !accessionB) {
      return res.status(400).json({ error: "accessionA and accessionB are required" });
    }
    if (accessionA === accessionB) {
      return res.status(400).json({ error: "Pick two different filings" });
    }
    if (!section || !(section in SECTION_LABELS)) {
      return res.status(400).json({ error: "Invalid section" });
    }
    const fa = await storage.getFilingByAccession(accessionA);
    const fb = await storage.getFilingByAccession(accessionB);
    if (!fa || !fb) return res.status(404).json({ error: "Filing not found" });
    try {
      const result = await compareFilings(fa, fb, section as SectionKey);
      res.json(result);
    } catch (e: any) {
      console.error("Comparison failed:", e?.message || e);
      res.status(500).json({ error: e?.message || "Comparison failed" });
    }
  });

  // ─── Findings chat (Claude Q&A over the findings corpus) ─
  // Takes a chat history (last entry must be the new user question) and
  // returns Claude's answer + token usage. The findings corpus is sent in the
  // system prompt with cache_control so follow-up turns are cheap.
  app.post("/api/findings/chat", requireAuth, async (req, res) => {
    if (!isReviewEnabled()) {
      return res
        .status(409)
        .json({ error: "Claude is not configured (ANTHROPIC_API_KEY is not set)." });
    }
    const { messages } = req.body as {
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }
    // Validate shape and that the last turn is a non-empty user message.
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
        return res.status(400).json({ error: "Each message needs role ('user'|'assistant') and string content" });
      }
    }
    const last = messages[messages.length - 1];
    if (last.role !== "user" || !last.content.trim()) {
      return res.status(400).json({ error: "Last message must be a non-empty user question" });
    }
    try {
      const result = await chatAboutFindings(messages);
      res.json({
        answer: result.answer,
        usage: result.usage,
        costUsd: Math.round(reviewCostUsd(result.usage) * 10000) / 10000,
        corpusFindingsCount: result.corpusFindingsCount,
        corpusFilingsCount: result.corpusFilingsCount,
        truncated: result.truncated,
        scopedTickers: result.scopedTickers,
        citations: result.citations,
      });
    } catch (e: any) {
      console.error("Findings chat failed:", e?.message || e);
      res.status(500).json({ error: e?.message || "Chat failed" });
    }
  });

  // Deep-dive chat for one specific filing — answers questions against the
  // filing's full PDF text (not just the extracted findings). Useful for
  // routine financial/operational content the corpus chat can't cover.
  app.post("/api/filings/:accession/ask", requireAuth, async (req, res) => {
    if (!isReviewEnabled()) {
      return res
        .status(409)
        .json({ error: "Claude is not configured (ANTHROPIC_API_KEY is not set)." });
    }
    const accession = req.params.accession as string;
    const { messages } = req.body as {
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }
    for (const m of messages) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
        return res.status(400).json({ error: "Each message needs role ('user'|'assistant') and string content" });
      }
    }
    const last = messages[messages.length - 1];
    if (last.role !== "user" || !last.content.trim()) {
      return res.status(400).json({ error: "Last message must be a non-empty user question" });
    }
    try {
      const result = await chatAboutFiling(accession, messages);
      res.json({
        answer: result.answer,
        usage: result.usage,
        costUsd: Math.round(reviewCostUsd(result.usage) * 10000) / 10000,
        ticker: result.ticker,
        form: result.form,
        date: result.date,
        truncated: result.truncated,
      });
    } catch (e: any) {
      console.error("Filing chat failed:", e?.message || e);
      res.status(500).json({ error: e?.message || "Chat failed" });
    }
  });

  // ─── Per-finding triage (star / posted / dismissed) ──────

  app.get("/api/finding-actions", requireAuth, async (req, res) => {
    res.json(await storage.getFindingActions(req.user!.id));
  });

  app.post("/api/finding-actions", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const { accessionNumber, findingIndex, status } = req.body as {
      accessionNumber?: string;
      findingIndex?: number;
      status?: string | null;
    };
    if (!accessionNumber || typeof findingIndex !== "number") {
      return res.status(400).json({ error: "accessionNumber and numeric findingIndex are required" });
    }
    // Empty / "new" clears any existing action (untriage)
    if (!status || status === "new") {
      await storage.clearFindingAction(userId, accessionNumber, findingIndex);
      return res.json({ status: null });
    }
    if (!["starred", "dismissed", "posted"].includes(status)) {
      return res.status(400).json({ error: "status must be starred, posted, dismissed, or new" });
    }
    await storage.setFindingAction(userId, accessionNumber, findingIndex, status);
    res.json({ status });
  });

  // Review filings already in the library (not just freshly fetched ones)
  app.post("/api/filings/review", requireAuth, async (_req, res) => {
    if (!isReviewEnabled()) {
      return res
        .status(409)
        .json({ error: "Claude review is not configured (ANTHROPIC_API_KEY is not set)." });
    }
    const queued = await storage.markCompleteFilingsForReview();
    if (queued > 0) {
      kickReviewProcessor().catch((err) => console.error("Review processor failed:", err));
    }
    res.json({ queued });
  });

  // Retry / run review for a single filing
  app.post("/api/filings/:accession/review", requireAuth, async (req, res) => {
    if (!isReviewEnabled()) {
      return res
        .status(409)
        .json({ error: "Claude review is not configured (ANTHROPIC_API_KEY is not set)." });
    }
    const accession = req.params.accession as string;
    const filing = await storage.getFilingByAccession(accession);
    if (!filing) return res.status(404).json({ error: "Filing not found" });
    if (filing.status !== "complete") {
      return res.status(400).json({ error: "Filing isn't rendered yet" });
    }
    await storage.markFilingForReview(accession);
    kickReviewProcessor().catch((err) => console.error("Review processor failed:", err));
    res.json({ ok: true });
  });

  // Re-attempt a render that previously errored (or got interrupted). The
  // main Fetch button skips anything already in the DB, so without this an
  // errored filing is stuck — the user has no way to retry it from the UI.
  // We delete the row, then run the pipeline scoped to just that filing so
  // the pipeline re-fetches from SEC and creates a fresh row.
  app.post("/api/filings/:accession/retry-render", requireAuth, async (req, res) => {
    const accession = req.params.accession as string;
    const filing = await storage.getFilingByAccession(accession);
    if (!filing) return res.status(404).json({ error: "Filing not found" });
    const userId = req.user!.id;

    await storage.deleteFiling(filing.id);

    const input = JSON.stringify({
      tickers: [
        {
          ticker: filing.ticker,
          cik: filing.cik,
          filing_types: [filing.filingType],
        },
      ],
      date_from: filing.filingDate,
      date_to: filing.filingDate,
      limit_per_ticker: 5,
    });
    const cikByTicker = new Map<string, string>([[filing.ticker, filing.cik]]);
    const result = await runFetchPipeline(input, { userId, cikByTicker });
    // Sweep any row this retry left at 'rendering' (e.g. the watchdog killed
    // mid-attempt) so the retry doesn't replace one stuck row with another.
    storage
      .recoverStaleRenders([filing.ticker])
      .catch((err) => console.error("Stale-render recovery failed:", err));
    if (!result.success) {
      return res.status(500).json({ error: result.error || "Retry render failed" });
    }
    kickReviewProcessor().catch((err) => console.error("Review processor failed:", err));
    res.json({
      ok: true,
      rerendered: result.completedAccessions.length,
      events: result.events,
    });
  });

  // ─── MD&A digest (analyst view) ──────────────────────────

  function mdnaCost(f: {
    mdnaInputTokens: number | null;
    mdnaOutputTokens: number | null;
    mdnaCacheReadTokens: number | null;
    mdnaCacheCreationTokens: number | null;
  }): number | null {
    if (f.mdnaInputTokens == null && f.mdnaOutputTokens == null) return null;
    return (
      Math.round(
        reviewCostUsd({
          inputTokens: f.mdnaInputTokens ?? 0,
          outputTokens: f.mdnaOutputTokens ?? 0,
          cacheReadTokens: f.mdnaCacheReadTokens ?? 0,
          cacheCreationTokens: f.mdnaCacheCreationTokens ?? 0,
        }) * 10000,
      ) / 10000
    );
  }

  function parseDigest(raw: string | null): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // List every rendered 10-K/10-Q with its MD&A digest state, for the MD&A tab.
  app.get("/api/mdna", requireAuth, async (_req, res) => {
    const filings = await storage.getFilings({ status: "complete" });
    const items = filings
      .filter((f) => isMdnaEligible(f.filingType))
      .map((f) => ({
        accession: f.accessionNumber,
        ticker: f.ticker,
        form: f.filingType,
        date: f.filingDate,
        mdnaStatus: f.mdnaStatus,
        analyzedAt: f.mdnaAnalyzedAt,
        error: f.mdnaError,
        costUsd: mdnaCost(f),
        digest: parseDigest(f.mdnaDigest),
      }));
    res.json(items);
  });

  // Generate (or regenerate) the MD&A digest for one filing. Synchronous —
  // the analyst is waiting on it. Tracked in its own mdna_* columns, so it
  // never counts against the editorial review spend cap.
  app.post("/api/filings/:accession/mdna", requireAuth, async (req, res) => {
    if (!isReviewEnabled()) {
      return res
        .status(409)
        .json({ error: "Claude is not configured (ANTHROPIC_API_KEY is not set)." });
    }
    const accession = req.params.accession as string;
    const filing = await storage.getFilingByAccession(accession);
    if (!filing) return res.status(404).json({ error: "Filing not found" });
    if (!isMdnaEligible(filing.filingType)) {
      return res.status(400).json({ error: "MD&A analysis only applies to 10-K and 10-Q filings." });
    }
    if (filing.status !== "complete") {
      return res.status(400).json({ error: "Filing isn't rendered yet — fetch and render it first." });
    }
    await storage.setFilingMdnaStatus(accession, "analyzing");
    try {
      const result = await analyzeMdna(filing);
      await storage.setFilingMdnaResult(accession, result.digest, result.usage);
      res.json({
        digest: result.digest,
        costUsd: Math.round(reviewCostUsd(result.usage) * 10000) / 10000,
        analyzedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      const message = e?.message || "MD&A analysis failed";
      await storage.setFilingMdnaError(accession, String(message));
      console.error("MD&A analysis failed:", message);
      res.status(500).json({ error: message });
    }
  });

  // Download a PDF by accession number
  // Citation deep-link: look up which page of the PDF contains the cited
  // quote, then redirect to the inline PDF with `#page=N` so the browser's
  // native PDF viewer jumps to that page. Falls back to page 1 if the quote
  // can't be located (e.g. it spans pages or the wording was paraphrased).
  app.get("/api/filings/:accession/view", requireAuth, async (req, res) => {
    const filing = await storage.getFilingByAccession(req.params.accession as string);
    if (!filing || !filing.pdfPath) {
      return res.status(404).json({ error: "PDF not found" });
    }
    const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
    const pipelinePath = path.join(PIPELINE_ROOT, filing.pdfPath);
    const fullPath = fs.existsSync(appPath) ? appPath : fs.existsSync(pipelinePath) ? pipelinePath : null;
    if (!fullPath) {
      return res.status(404).json({ error: "PDF file missing from disk" });
    }
    const quote = typeof req.query.q === "string" ? req.query.q : "";
    let page: number | null = null;
    if (quote.trim()) {
      try {
        page = await findPageForQuote(fullPath, quote);
      } catch (err) {
        console.error("[view] page lookup failed:", err);
      }
    }
    const target =
      `/api/filings/${encodeURIComponent(req.params.accession as string)}/pdf?inline=1` +
      `#page=${page ?? 1}`;
    res.redirect(302, target);
  });

  app.get("/api/filings/:accession/pdf", requireAuth, async (req, res) => {
    const filing = await storage.getFilingByAccession(req.params.accession as string);
    if (!filing || !filing.pdfPath) {
      return res.status(404).json({ error: "PDF not found" });
    }

    // Try app-managed storage first, fall back to pipeline output
    const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
    const pipelinePath = path.join(PIPELINE_ROOT, filing.pdfPath);
    const fullPath = fs.existsSync(appPath) ? appPath : fs.existsSync(pipelinePath) ? pipelinePath : null;

    if (!fullPath) {
      return res.status(404).json({ error: "PDF file missing from disk" });
    }

    const filename = `${filing.ticker}_${filing.filingType.replace(/ /g, "_")}_${filing.filingDate || filing.accessionNumber}.pdf`;
    // `?inline=1` tells the browser to display the PDF in-place (used by chat
    // citation links that open in a new tab). Default stays `attachment` so
    // the PDF Library's Download button still triggers a save.
    const inline = req.query.inline === "1" || req.query.inline === "true";
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${filename}"`,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(fullPath);
  });

  // ─── Filing management: delete, stats, view ────────────

  // Delete a single filing + remove PDF from disk
  app.delete("/api/filings/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const deleted = await storage.deleteFiling(id);
    if (!deleted) return res.status(404).json({ error: "Filing not found" });

    // Clean up PDF file from disk
    if (deleted.pdfPath) {
      const appPath = path.resolve(PDF_STORAGE_DIR, "..", deleted.pdfPath);
      try {
        if (fs.existsSync(appPath)) fs.unlinkSync(appPath);
      } catch (e) {
        console.error("Failed to remove PDF file:", e);
      }
    }
    res.status(204).send();
  });

  // Batch delete filings + remove PDF files
  app.post("/api/filings/batch-delete", requireAuth, async (req, res) => {
    const { ids } = req.body as { ids: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }

    // Delete one at a time to also clean up PDFs
    let deletedCount = 0;
    for (const id of ids) {
      const batchRows = await db.select().from(filingsTable).where(eq(filingsTable.id, id));
      const f = batchRows[0];
      if (!f) continue;

      const filing = await storage.deleteFiling(id);
      if (filing?.pdfPath) {
        const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
        try {
          if (fs.existsSync(appPath)) fs.unlinkSync(appPath);
        } catch (e) {
          console.error("Failed to remove PDF file:", e);
        }
      }
      deletedCount++;
    }
    res.json({ deleted: deletedCount });
  });

  // View PDF inline (opens in browser tab instead of downloading)
  app.get("/api/filings/:accession/view", requireAuth, async (req, res) => {
    const filing = await storage.getFilingByAccession(req.params.accession as string);
    if (!filing || !filing.pdfPath) {
      return res.status(404).json({ error: "PDF not found" });
    }

    const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
    const pipelinePath = path.join(PIPELINE_ROOT, filing.pdfPath);
    const fullPath = fs.existsSync(appPath) ? appPath : fs.existsSync(pipelinePath) ? pipelinePath : null;

    if (!fullPath) {
      return res.status(404).json({ error: "PDF file missing from disk" });
    }

    const filename = `${filing.ticker}_${filing.filingType.replace(/ /g, "_")}_${filing.filingDate || filing.accessionNumber}.pdf`;
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(fullPath);
  });

  // ─── Ticker search / CIK lookup ─────────────────────────

  app.get("/api/resolve-ticker/:ticker", requireAuth, async (req, res) => {
    const tickerParam = (req.params.ticker as string).toUpperCase().trim();
    try {
      const response = await fetch(SEC_COMPANY_TICKERS_URL, {
        headers: { "User-Agent": SEC_USER_AGENT },
      });
      if (!response.ok) throw new Error(`SEC API returned ${response.status}`);
      const data = (await response.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;

      const matches: Array<{ ticker: string; cik: string; company: string }> = [];
      for (const entry of Object.values(data)) {
        if (entry.ticker?.toUpperCase().startsWith(tickerParam)) {
          matches.push({
            ticker: entry.ticker,
            cik: String(entry.cik_str).padStart(10, "0"),
            company: entry.title || "",
          });
          if (matches.length >= 10) break;
        }
      }
      res.json(matches);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to search SEC tickers" });
    }
  });
}
