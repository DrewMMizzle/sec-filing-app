import type { Express } from "express";
import type { Server } from "http";
import { storage, initDatabase } from "./storage";
import { insertWatchlistSchema, insertTickerSchema } from "@shared/schema";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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

export async function registerRoutes(server: Server, app: Express): Promise<void> {
  // Initialize database tables + indexes
  await initDatabase();

  // ─── Watchlists ──────────────────────────────────────────

  app.get("/api/watchlists", async (_req, res) => {
    const lists = await storage.getWatchlists();
    const result = await Promise.all(
      lists.map(async (wl) => ({
        ...wl,
        tickerCount: (await storage.getTickersByWatchlist(wl.id)).length,
      })),
    );
    res.json(result);
  });

  app.get("/api/watchlists/:id", async (req, res) => {
    const id = Number(req.params.id);
    const wl = await storage.getWatchlist(id);
    if (!wl) return res.status(404).json({ error: "Watchlist not found" });
    const tickers = await storage.getTickersByWatchlist(id);
    res.json({ ...wl, tickers });
  });

  app.post("/api/watchlists", async (req, res) => {
    const parsed = insertWatchlistSchema.safeParse(req.body);
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

  app.patch("/api/watchlists/:id", async (req, res) => {
    const id = Number(req.params.id);
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    const updated = await storage.renameWatchlist(id, name.trim());
    if (!updated) return res.status(404).json({ error: "Watchlist not found" });
    res.json(updated);
  });

  app.delete("/api/watchlists/:id", async (req, res) => {
    const id = Number(req.params.id);
    await storage.deleteWatchlist(id);
    res.status(204).send();
  });

  // ─── Tickers ─────────────────────────────────────────────

  app.get("/api/watchlists/:id/tickers", async (req, res) => {
    const id = Number(req.params.id);
    const wl = await storage.getWatchlist(id);
    if (!wl) return res.status(404).json({ error: "Watchlist not found" });
    const tickers = await storage.getTickersByWatchlist(id);
    const result = tickers.map((t) => ({
      ...t,
      filingTypes: JSON.parse(t.filingTypes) as string[],
    }));
    res.json(result);
  });

  app.post("/api/watchlists/:id/tickers", async (req, res) => {
    const watchlistId = Number(req.params.id);
    const wl = await storage.getWatchlist(watchlistId);
    if (!wl) return res.status(404).json({ error: "Watchlist not found" });

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

  app.delete("/api/tickers/:id", async (req, res) => {
    const id = Number(req.params.id);
    await storage.removeTicker(id);
    res.status(204).send();
  });

  app.patch("/api/tickers/:id/filing-types", async (req, res) => {
    const id = Number(req.params.id);
    const { filingTypes } = req.body;
    if (!Array.isArray(filingTypes)) {
      return res.status(400).json({ error: "filingTypes must be an array" });
    }
    const updated = await storage.updateTickerFilingTypes(id, JSON.stringify(filingTypes));
    if (!updated) return res.status(404).json({ error: "Ticker not found" });
    res.json({ ...updated, filingTypes });
  });

  // ─── Export watchlist.json ───────────────────────────────

  app.get("/api/export-watchlist", async (_req, res) => {
    const data = await storage.exportWatchlistJson();
    res.json(data);
  });

  // ─── All unique tickers across watchlists ────────────────

  app.get("/api/all-tickers", async (_req, res) => {
    const data = await storage.getAllTickers();
    res.json(data);
  });

  // ─── Filings: list, stats, fetch, download, manage ────────

  // Filing stats summary (must come before /:accession routes)
  app.get("/api/filings/stats", async (_req, res) => {
    const stats = await storage.getFilingStats();
    res.json(stats);
  });

  app.get("/api/filings", async (req, res) => {
    const { ticker, filingType, dateFrom, dateTo, status } = req.query as Record<string, string | undefined>;
    const results = await storage.getFilings({
      ticker,
      filingType,
      dateFrom,
      dateTo,
      status,
    });
    res.json(results);
  });

  // Trigger fetch+render for selected tickers + date range
  app.post("/api/filings/fetch", async (req, res) => {
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
    const alreadyComplete = await storage.getCompleteAccessions(tickerNames);

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
  app.get("/api/filings/:accession/pdf", async (req, res) => {
    const filing = await storage.getFilingByAccession(req.params.accession);
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
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(fullPath);
  });

  // ─── Filing management: delete, stats, view ────────────

  // Delete a single filing + remove PDF from disk
  app.delete("/api/filings/:id", async (req, res) => {
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
  app.post("/api/filings/batch-delete", async (req, res) => {
    const { ids } = req.body as { ids: number[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required" });
    }

    // Delete one at a time to also clean up PDFs
    for (const id of ids) {
      const filing = await storage.deleteFiling(id);
      if (filing?.pdfPath) {
        const appPath = path.resolve(PDF_STORAGE_DIR, "..", filing.pdfPath);
        try {
          if (fs.existsSync(appPath)) fs.unlinkSync(appPath);
        } catch (e) {
          console.error("Failed to remove PDF file:", e);
        }
      }
    }
    res.json({ deleted: ids.length });
  });

  // View PDF inline (opens in browser tab instead of downloading)
  app.get("/api/filings/:accession/view", async (req, res) => {
    const filing = await storage.getFilingByAccession(req.params.accession);
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

  app.get("/api/resolve-ticker/:ticker", async (req, res) => {
    const tickerParam = req.params.ticker.toUpperCase().trim();
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
