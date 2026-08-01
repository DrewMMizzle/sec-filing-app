import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Single source of truth for where rendered PDFs live and how a stored path is
// turned back into a file on disk. routes.ts and review.ts previously each
// computed the roots and open-coded the same two-root resolution in eight
// places, none of which checked that the result stayed inside either root.

// Works in both ESM (dev via tsx) and CJS (prod via esbuild)
const __filename_compat = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const __dirname_compat = path.dirname(__filename_compat);

export const PIPELINE_ROOT =
  process.env.PIPELINE_ROOT || path.resolve(__dirname_compat, "../../sec-pdf-pipeline");
export const PDF_STORAGE_DIR =
  process.env.PDF_STORAGE_DIR || path.resolve(__dirname_compat, "..", "pdfs");

// Stored pdfPath values are relative to the PARENT of PDF_STORAGE_DIR (they
// look like "pdfs/AAPL/10-K/xxx.pdf"), which is why resolution starts a level
// up. That also means the resolved path must be re-checked against the storage
// dir itself, not against the parent.
const STORAGE_PARENT = path.resolve(PDF_STORAGE_DIR, "..");

/** True if `candidate` resolves to `root` or something inside it. */
export function isUnder(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Turn one untrusted string into a single safe path segment.
 *
 * Tickers, form types and accession numbers all come from the pipeline's JSON
 * events, which echo back whatever the fetch request supplied. A ticker of
 * "../../../../tmp/pwned" put a rendered PDF at /tmp/pwned/10-K/... and stored
 * a pdfPath that resolved there, so every later read, download and delete
 * followed it straight out of the storage root.
 *
 * Returns `fallback` when nothing usable survives — including for "." and
 * "..", which pass a naive character-class filter unharmed.
 */
export function safeSegment(raw: unknown, fallback: string): string {
  const cleaned = String(raw ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 64);
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

/**
 * Resolve `relPath` against `root`, or null if it escapes.
 * Use for anything built from a value the app didn't generate itself.
 */
export function resolveUnder(root: string, relPath: string): string | null {
  if (!relPath) return null;
  const abs = path.resolve(root, relPath);
  return isUnder(root, abs) ? abs : null;
}

/**
 * Resolve a stored `pdfPath` to a real file, trying app storage first and the
 * pipeline's output second — the two places a rendered PDF can be.
 *
 * Returns null when the path escapes both roots, so a poisoned row written
 * before the traversal was fixed reads as "missing" instead of handing back an
 * arbitrary file. Rows like that already exist in any database this ran
 * against, so filtering on read matters as much as blocking the write.
 */
export function resolveStoredPdf(pdfPath: string | null | undefined): string | null {
  if (!pdfPath) return null;
  const appPath = path.resolve(STORAGE_PARENT, pdfPath);
  if (isUnder(PDF_STORAGE_DIR, appPath) && fs.existsSync(appPath)) return appPath;
  const pipelinePath = path.resolve(PIPELINE_ROOT, pdfPath);
  if (isUnder(PIPELINE_ROOT, pipelinePath) && fs.existsSync(pipelinePath)) return pipelinePath;
  return null;
}

/**
 * A filename safe to put in a Content-Disposition header. `filing.ticker` is
 * stored data that reaches the header unquoted; a value containing a double
 * quote would end the filename parameter early.
 */
export function safeDownloadFilename(parts: Array<string | null | undefined>): string {
  const name = parts
    .map((p) => String(p ?? "").replace(/[^A-Za-z0-9._-]+/g, "_"))
    .filter(Boolean)
    .join("_")
    .slice(0, 120);
  return `${name || "filing"}.pdf`;
}
