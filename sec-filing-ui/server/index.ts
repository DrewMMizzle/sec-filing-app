import express, { type Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { backfillSP500 } from "./seed-sp500";
import { resumeReviews } from "./review";
import { startScheduler } from "./scheduler";
import { createServer } from "http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(cookieParser());

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// express.json rejects malformed bodies by throwing a SyntaxError whose
// message is the raw parser complaint ("Expected property name or '}' in JSON
// at position 1"). That's internal detail with no value to a caller, so
// answer with a plain 400 instead and let everything else through.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && (err as any).status === 400 && "body" in err) {
    res.status(400).json({ error: "Malformed JSON in request body." });
    return;
  }
  next(err);
});

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// Cap on how much of a response body goes into the access log. Without it a
// single `GET /api/filings` writes its entire JSON array — thousands of
// filings, megabytes — onto one log line, which drowns the boot sequence,
// warnings and errors that anyone reading the logs is actually looking for.
// The prefix is still enough to tell what came back; the length suffix says
// how much was elided.
const MAX_LOGGED_BODY_CHARS = 400;

function summarizeBody(body: unknown): string | null {
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch {
    return "[unserializable response body]";
  }
  if (!json) return null;
  if (json.length <= MAX_LOGGED_BODY_CHARS) return json;
  return `${json.slice(0, MAX_LOGGED_BODY_CHARS)}… [truncated, ${json.length} chars]`;
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const summary = summarizeBody(capturedJsonResponse);
        if (summary) logLine += ` :: ${summary}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Anything under /api that no route matched is a client error, not a page.
  // Without this the SPA catch-all further down answers unmatched API paths
  // and methods with 200 + index.html — so `DELETE /api/all-tickers` looked
  // like it succeeded, and any client parsing the reply got HTML where it
  // expected JSON.
  app.use("/api", (req: Request, res: Response) => {
    res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
  });

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      // Backfill the S&P 500 watchlist for existing users in the background so
      // it never delays startup or the healthcheck.
      backfillSP500().catch((err) => console.error("S&P 500 backfill failed:", err));
      // Resume any material-disclosure reviews left pending from a prior run.
      resumeReviews().catch((err) => console.error("Review resume failed:", err));
      // Arm the nightly fetch (a no-op unless NIGHTLY_FETCH_UTC_HOUR is set).
      startScheduler();
    },
  );
})();
