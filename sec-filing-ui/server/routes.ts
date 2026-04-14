import type { Express } from "express";
import type { Server } from "http";
import { storage, initDatabase } from "./storage";
import { insertWatchlistSchema } from "@shared/schema";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { hashPassword, verifyPassword, createSession, clearSession, requireAuth } from "./auth";
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
    let ownerName: string | undefined;
    if (access !== "owner") {
      const owner = await storage.getUserById(wl.userId);
      ownerName = owner?.displayName;
    }
    res.json({ ...wl, tickers: tickerRows, access, ownerName });
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
      filingTypes: JSON.parse(t.filingTypes) as string[],
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

    const { ticker, filingTypes } = req.body;
    if (!ticker || typeof ticker !== "string") {
      return res.status(400).json({ error: "ticker is required" });
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
        : ["10-K", "10-Q", "8-K"];

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

  // ─── Filings: list, stats, fetch, download, manage ────────

  // Filing stats summary (must come before /:accession routes)
  app.get("/api/filings/stats", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const stats = await storage.getFilingStats(userId);
    res.json(stats);
  });

  app.get("/api/filings", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const { ticker, filingType, dateFrom, dateTo, status } = req.query as Record<string, string | undefined>;
    const results = await storage.getFilings(userId, {
      ticker,
      filingType,
      dateFrom,
      dateTo,
      status,
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

    // ── Dedup: check which accessions are already complete in our DB ──
    const tickerNames = tickerList.map((t) => t.ticker);
    const alreadyComplete = await storage.getCompleteAccessions(userId, tickerNames);

    const input = JSON.stringify({
      tickers: tickerList,
      date_from: dateFrom || null,
      date_to: dateTo || null,
      limit_per_ticker: limitPerTicker || 10,
      skip_accessions: Array.from(alreadyComplete),
    });

    // Spawn the Python pipeline script
    const pythonScript = path.join(PIPELINE_ROOT, "scripts", "fetch_filings.py");

    // Check if the script exists
    if (!fs.existsSync(pythonScript)) {
      return res.status(500).json({ error: "Pipeline script not found. Make sure sec-pdf-pipeline is in the workspace." });
    }

    const child = spawn("python3", [pythonScript], {
      cwd: PIPELINE_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    child.stdin.write(input);
    child.stdin.end();

    // Collect events from the pipeline
    const events: any[] = [];
    let stderrOutput = "";

    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          events.push(event);

          // Track filings in our DB (fire-and-forget async)
          if (event.event === "rendering") {
            storage.upsertFiling({
              ticker: event.ticker,
              cik: tickerList.find((t) => t.ticker === event.ticker)?.cik || "",
              accessionNumber: event.accession,
              filingType: event.filing_type,
              filingDate: event.filing_date || null,
              status: "rendering",
              createdAt: new Date().toISOString(),
              userId,
            }).catch((err) => console.error("Failed to upsert filing:", err));
          } else if (event.event === "complete") {
            // Copy the rendered PDF into app-managed storage
            const pipelinePdf = path.join(PIPELINE_ROOT, event.path);
            const ticker = event.ticker || "UNKNOWN";
            const safeType = (event.filing_type || "filing").replace(/ /g, "_");
            const destDir = path.join(PDF_STORAGE_DIR, ticker, safeType);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }
            const destFile = path.join(destDir, `${event.accession}.pdf`);
            try {
              fs.copyFileSync(pipelinePdf, destFile);
            } catch (copyErr) {
              console.error(`Failed to copy PDF to app storage: ${copyErr}`);
            }

            // Store the app-local relative path
            const appRelPath = path.relative(path.resolve(PDF_STORAGE_DIR, ".."), destFile);
            storage.updateFilingStatus(
              event.accession,
              "complete",
              appRelPath,
              event.size,
            ).catch((err) => console.error("Failed to update filing status:", err));
          } else if (event.event === "error" && event.accession) {
            storage.updateFilingStatus(
              event.accession,
              "error",
              undefined,
              undefined,
              event.message,
            ).catch((err) => console.error("Failed to update filing error:", err));
          }
        } catch {
          // non-JSON line from Python logging
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    child.on("close", (code) => {
      const doneEvent = events.find((e) => e.event === "done");
      if (code === 0 && doneEvent) {
        res.json({
          success: true,
          totalRendered: doneEvent.total_rendered,
          totalSkipped: doneEvent.total_skipped || 0,
          totalErrors: doneEvent.total_errors,
          events,
        });
      } else {
        res.status(500).json({
          success: false,
          error: stderrOutput || "Pipeline process failed",
          events,
        });
      }
    });

    child.on("error", (err) => {
      res.status(500).json({ error: `Failed to start pipeline: ${err.message}` });
    });
  });

  // Download a PDF by accession number
  app.get("/api/filings/:accession/pdf", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const filing = await storage.getFilingByAccession(req.params.accession as string);
    if (!filing || !filing.pdfPath) {
      return res.status(404).json({ error: "PDF not found" });
    }
    if (filing.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Try app-managed storage first, fall back to pipeline output
    const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
    const pipelinePath = path.join(PIPELINE_ROOT, filing.pdfPath);
    const fullPath = fs.existsSync(appPath) ? appPath : fs.existsSync(pipelinePath) ? pipelinePath : null;

    if (!fullPath) {
      return res.status(404).json({ error: "PDF file missing from disk" });
    }

    const filename = `${filing.ticker}_${filing.filingType.replace(/ /g, "_")}_${filing.filingDate || filing.accessionNumber}.pdf`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(fullPath);
  });

  // ─── Filing management: delete, stats, view ────────────

  // Delete a single filing + remove PDF from disk
  app.delete("/api/filings/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.user!.id;
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    // Verify ownership before deleting
    const filingRows = await db.select().from(filingsTable).where(eq(filingsTable.id, id));
    const filing = filingRows[0];
    if (!filing) return res.status(404).json({ error: "Filing not found" });
    if (filing.userId !== userId) return res.status(403).json({ error: "Access denied" });

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
    const userId = req.user!.id;
    const { ids } = req.body as { ids: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }

    // Delete one at a time to also clean up PDFs, verifying ownership
    let deletedCount = 0;
    for (const id of ids) {
      const batchRows = await db.select().from(filingsTable).where(eq(filingsTable.id, id));
      const f = batchRows[0];
      if (!f || f.userId !== userId) continue;

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
    const userId = req.user!.id;
    const filing = await storage.getFilingByAccession(req.params.accession as string);
    if (!filing || !filing.pdfPath) {
      return res.status(404).json({ error: "PDF not found" });
    }
    if (filing.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
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
