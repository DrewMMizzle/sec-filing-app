import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // Fall through to index.html for any non-file route so the SPA can boot.
  // A path-less middleware is used deliberately: Express 5's "/{*path}" pattern
  // does NOT match a malformed path like a stray double slash ("//"), which
  // would otherwise 404 before the client-side hash router ever runs.
  app.use((_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
