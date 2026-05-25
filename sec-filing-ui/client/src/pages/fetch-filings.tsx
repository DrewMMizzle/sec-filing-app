import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { useToast } from "@/hooks/use-toast";
import { Search, Download, Loader2, FileText, Calendar as CalendarIcon, Check, X, AlertCircle, ShieldAlert, ShieldCheck, RefreshCw, Wallet, PauseCircle, ChevronDown, Eye, EyeOff } from "lucide-react";
import type { Filing } from "@shared/schema";
import { CATEGORY_LABELS, parseFindings, estimateReviewCost, formatCostRange } from "@/lib/findings";

// SEC filing dates are plain calendar dates (YYYY-MM-DD); convert to/from local
// Date objects so the calendar never shifts a day across timezones.
function toYmd(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

function parseYmd(s: string): Date | undefined {
  if (!s) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
}

type TickerInfo = {
  ticker: string;
  cik: string;
  filingTypes: string[];
};

type WatchlistSummary = {
  id: number;
  name: string;
  tickerCount: number;
};

type FetchResult = {
  success: boolean;
  totalRendered: number;
  totalSkipped: number;
  totalErrors: number;
  events: any[];
};

export default function FetchFilings() {
  const { toast } = useToast();

  // Date range state (kept as YYYY-MM-DD strings for the API + filtering)
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const dateRange: DateRange | undefined =
    dateFrom || dateTo ? { from: parseYmd(dateFrom), to: parseYmd(dateTo) } : undefined;

  const handleRangeSelect = (range: DateRange | undefined) => {
    setDateFrom(range?.from ? toYmd(range.from) : "");
    setDateTo(range?.to ? toYmd(range.to) : "");
  };

  const rangeLabel = (() => {
    const from = parseYmd(dateFrom);
    const to = parseYmd(dateTo);
    if (from && to) return `${format(from, "MMM d, yyyy")} – ${format(to, "MMM d, yyyy")}`;
    if (from) return `${format(from, "MMM d, yyyy")} – End date`;
    if (to) return `Start date – ${format(to, "MMM d, yyyy")}`;
    return "All dates";
  })();

  // Ticker selection state
  const [selectedWatchlist, setSelectedWatchlist] = useState<string>("all");
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(new Set());
  const [limitPerTicker, setLimitPerTicker] = useState(5);
  const [tickerSearch, setTickerSearch] = useState("");

  // Confirmation dialog for large/expensive batches
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => void } | null>(null);
  const CONFIRM_THRESHOLD = 25;

  // Queries
  const { data: allTickers = [] } = useQuery<TickerInfo[]>({
    queryKey: ["/api/all-tickers"],
  });

  const { data: watchlists = [] } = useQuery<WatchlistSummary[]>({
    queryKey: ["/api/watchlists"],
  });

  const { data: config } = useQuery<{ reviewEnabled: boolean }>({
    queryKey: ["/api/config"],
  });
  const reviewEnabled = config?.reviewEnabled ?? false;

  // Current Claude spend + cap, so we can warn before a big run and flag pauses.
  const { data: usage } = useQuery<{
    reviewedCount: number;
    costUsd: number;
    budgetUsd: number | null;
    pendingCount: number;
    paused: boolean;
  }>({
    queryKey: ["/api/review/usage"],
    refetchInterval: (query) => {
      const data = query.state.data as { paused?: boolean } | undefined;
      // Read filings from the cache to decide whether a run is in flight. Poll
      // through the render phase too so spend starts ticking as soon as the
      // first reviews run. Fast while active; slow (not stopped) while paused.
      const rows = queryClient.getQueryData<Filing[]>(["/api/filings"]);
      const rendering = rows?.some((f) => f.status === "rendering");
      const reviewing = rows?.some(
        (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
      );
      if (rendering) return 5000;
      if (reviewing) return data?.paused ? 30000 : 5000;
      return false;
    },
  });
  const paused = usage?.paused ?? false;

  // Team-wide Claude spend cap (governs the auto-review that runs on fetch)
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [tickerListOpen, setTickerListOpen] = useState(false);

  // Show/hide the running Claude spend (persisted) — handy when screen-sharing.
  const [showSpend, setShowSpend] = useState(() => {
    try {
      return localStorage.getItem("hideAiSpend") !== "1";
    } catch {
      return true;
    }
  });
  const toggleSpend = () =>
    setShowSpend((v) => {
      const next = !v;
      try {
        localStorage.setItem("hideAiSpend", next ? "0" : "1");
      } catch {
        // ignore (private mode, etc.)
      }
      return next;
    });

  // While a (long, synchronous) fetch request is in flight, poll the filings and
  // spend queries so render/review progress and spend update live during the run
  // rather than only after the request returns.
  const fetchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startFetchPolling = () => {
    if (fetchPollRef.current) return;
    fetchPollRef.current = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/filings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/review/usage"] });
    }, 4000);
  };
  const stopFetchPolling = () => {
    if (fetchPollRef.current) {
      clearInterval(fetchPollRef.current);
      fetchPollRef.current = null;
    }
  };
  useEffect(() => () => stopFetchPolling(), []);
  const budgetMutation = useMutation<{ budgetUsd: number | null }, Error, number | null>({
    mutationFn: async (budgetUsd) => {
      const res = await apiRequest("POST", "/api/review/budget", { budgetUsd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update spend cap");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/review/usage"] });
      queryClient.invalidateQueries({ queryKey: ["/api/filings"] });
      setBudgetOpen(false);
      toast({
        title:
          data.budgetUsd === null
            ? "Spend cap removed"
            : `Spend cap set to $${data.budgetUsd.toFixed(2)}`,
      });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const openBudgetDialog = () => {
    setBudgetInput(usage?.budgetUsd != null ? String(usage.budgetUsd) : "");
    setBudgetOpen(true);
  };
  const saveBudget = () => {
    const trimmed = budgetInput.trim();
    if (trimmed === "") {
      budgetMutation.mutate(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      toast({ title: "Enter a valid amount", description: "Use a non-negative dollar amount.", variant: "destructive" });
      return;
    }
    budgetMutation.mutate(n);
  };

  const { data: existingFilings = [], refetch: refetchFilings } = useQuery<Filing[]>({
    queryKey: ["/api/filings"],
    // Poll while a run is active so render + review progress appear live. Track
    // the render phase too (not just reviews). When the spend cap pauses the
    // review queue, slow the poll instead of stopping so the page recovers on
    // its own if the team-wide cap is raised elsewhere.
    refetchInterval: (query) => {
      const rows = query.state.data as Filing[] | undefined;
      const rendering = rows?.some((f) => f.status === "rendering");
      const reviewing = rows?.some(
        (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
      );
      if (rendering) return 4000;
      if (reviewing) {
        const isPaused =
          (queryClient.getQueryData(["/api/review/usage"]) as { paused?: boolean } | undefined)?.paused ?? false;
        return isPaused ? 30000 : 4000;
      }
      return false;
    },
  });

  // Filter tickers by selected watchlist
  const watchlistTickersQuery = useQuery<any>({
    queryKey: ["/api/watchlists", selectedWatchlist],
    queryFn: async () => {
      if (selectedWatchlist === "all") return null;
      const res = await apiRequest("GET", `/api/watchlists/${selectedWatchlist}`);
      return res.json();
    },
    enabled: selectedWatchlist !== "all",
  });

  const displayTickers = selectedWatchlist === "all"
    ? allTickers
    : (watchlistTickersQuery.data?.tickers || []).map((t: any) => ({
        ticker: t.ticker,
        cik: t.cik,
        filingTypes: typeof t.filingTypes === "string" ? JSON.parse(t.filingTypes) : t.filingTypes,
      }));

  // Tickers visible after the in-list search filter
  const visibleTickers: TickerInfo[] = tickerSearch.trim()
    ? displayTickers.filter((t: TickerInfo) =>
        t.ticker.toLowerCase().includes(tickerSearch.trim().toLowerCase()),
      )
    : displayTickers;

  // Toggle ticker selection
  const toggleTicker = (ticker: string) => {
    setSelectedTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  };

  const selectAll = () => {
    // Select all currently-visible (search-filtered) tickers, preserving any
    // already-selected ones that the search is hiding.
    setSelectedTickers((prev) => {
      const next = new Set(prev);
      visibleTickers.forEach((t: TickerInfo) => next.add(t.ticker));
      return next;
    });
  };

  const selectNone = () => {
    setSelectedTickers(new Set());
  };

  // Fetch mutation
  const fetchMutation = useMutation<FetchResult>({
    mutationFn: async () => {
      const tickersToFetch = displayTickers
        .filter((t: TickerInfo) => selectedTickers.has(t.ticker))
        .map((t: TickerInfo) => ({
          ticker: t.ticker,
          cik: t.cik,
          filing_types: t.filingTypes,
        }));

      const res = await apiRequest("POST", "/api/filings/fetch", {
        tickers: tickersToFetch,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        limitPerTicker,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Fetch failed");
      }
      return res.json();
    },
    onMutate: () => {
      startFetchPolling();
    },
    onSuccess: (data) => {
      const parts: string[] = [];
      if (data.totalRendered > 0) parts.push(`${data.totalRendered} new PDF(s) rendered`);
      if (data.totalSkipped > 0) parts.push(`${data.totalSkipped} already in library`);
      if (data.totalErrors > 0) parts.push(`${data.totalErrors} error(s)`);
      if (parts.length === 0) parts.push("No new filings found in range");
      toast({
        title: `Fetch complete — reviews continue below`,
        description: parts.join(", "),
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      // Hand off to the queries' own progress-aware polling.
      stopFetchPolling();
      refetchFilings();
      queryClient.invalidateQueries({ queryKey: ["/api/review/usage"] });
    },
  });

  // Re-run review for a single filing whose review errored
  const retryReviewMutation = useMutation({
    mutationFn: async (accession: string) => {
      const res = await apiRequest("POST", `/api/filings/${encodeURIComponent(accession)}/review`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Retry failed");
      }
      return res.json();
    },
    onSuccess: () => {
      refetchFilings();
      toast({ title: "Re-queued for review" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Re-render filings whose PDF is missing from disk (zombie "complete" rows)
  const renderMissingMutation = useMutation<{ rerendered: number; missingTotal: number; tickersRemaining: number }>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/filings/render-missing");
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Re-render failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      refetchFilings();
      if (data.missingTotal === 0) {
        toast({ title: "No missing PDFs — nothing to re-render" });
      } else {
        toast({
          title: `Re-rendered ${data.rerendered} filing${data.rerendered !== 1 ? "s" : ""}`,
          description:
            data.tickersRemaining > 0
              ? `${data.tickersRemaining} more ticker${data.tickersRemaining !== 1 ? "s" : ""} still have missing PDFs — run again.`
              : "All missing PDFs regenerated; reviews re-queued.",
        });
      }
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleFetch = () => {
    if (selectedTickers.size === 0) {
      toast({ title: "Select at least one ticker", variant: "destructive" });
      return;
    }
    if (selectedTickers.size > CONFIRM_THRESHOLD) {
      const est = selectedTickers.size * limitPerTicker;
      const capNote =
        reviewEnabled && usage?.budgetUsd != null
          ? ` A $${usage.budgetUsd.toFixed(2)} spend cap is set ($${usage.costUsd.toFixed(2)} used) — review pauses automatically if it's reached.`
          : reviewEnabled
            ? " Tip: use “Set cap” above to stop reviews automatically at a dollar limit."
            : "";
      const costNote = reviewEnabled
        ? ` Estimated Claude review cost: ${formatCostRange(estimateReviewCost(Array(est).fill(undefined)))} (Opus 4.7; rough).${capNote}`
        : "";
      setConfirm({
        title: "Fetch a large batch?",
        body:
          `This will fetch up to ~${est} filings across ${selectedTickers.size} tickers` +
          (reviewEnabled ? " and run a Claude review on each new one" : "") +
          `. It can take a while.` +
          costNote,
        action: () => fetchMutation.mutate(),
      });
      return;
    }
    fetchMutation.mutate();
  };

  // Filter existing filings by current date range
  const filteredFilings = existingFilings.filter((f) => {
    if (dateFrom && f.filingDate && f.filingDate < dateFrom) return false;
    if (dateTo && f.filingDate && f.filingDate > dateTo) return false;
    if (selectedTickers.size > 0 && !selectedTickers.has(f.ticker)) return false;
    return true;
  });

  const completedFilings = filteredFilings.filter((f) => f.status === "complete");

  // ── Render + review progress across the filings currently in scope ──
  const renderingCount = filteredFilings.filter((f) => f.status === "rendering").length;
  const renderErrorCount = filteredFilings.filter((f) => f.status === "error").length;

  const reviewableTotal = completedFilings.length; // only rendered filings get reviewed
  const reviewedFilings = completedFilings.filter((f) => f.reviewStatus === "done");
  const reviewedCount = reviewedFilings.length;
  const reviewingNowCount = filteredFilings.filter((f) => f.reviewStatus === "reviewing").length;
  const queuedCount = filteredFilings.filter((f) => f.reviewStatus === "pending").length;
  const reviewErrorCount = filteredFilings.filter((f) => f.reviewStatus === "error").length;
  const inFlightReviews = reviewingNowCount + queuedCount;
  const interestingCount = reviewedFilings.filter((f) => f.reviewFlagged).length;
  const totalFindings = reviewedFilings.reduce((n, f) => n + parseFindings(f).length, 0);

  const reviewSettled = reviewedCount + reviewErrorCount;
  const reviewProgressPct =
    reviewableTotal > 0 ? Math.round((reviewSettled / reviewableTotal) * 100) : 0;
  const runActive = renderingCount > 0 || inFlightReviews > 0;
  const showReviewBanner = filteredFilings.length > 0 && (reviewableTotal > 0 || renderingCount > 0);

  // Per-ticker rollup so it's clear which tickers are done vs outstanding.
  type TickerProgress = {
    ticker: string;
    total: number;
    reviewed: number;
    inFlight: number;
    errored: number;
  };
  const tickerProgress: TickerProgress[] = (() => {
    const map = new Map<string, TickerProgress>();
    for (const f of filteredFilings) {
      let p = map.get(f.ticker);
      if (!p) {
        p = { ticker: f.ticker, total: 0, reviewed: 0, inFlight: 0, errored: 0 };
        map.set(f.ticker, p);
      }
      p.total += 1;
      if (f.status === "error" || f.reviewStatus === "error") p.errored += 1;
      else if (f.reviewStatus === "done") p.reviewed += 1;
      else if (
        f.status === "rendering" ||
        f.reviewStatus === "pending" ||
        f.reviewStatus === "reviewing"
      )
        p.inFlight += 1;
    }
    // Outstanding/errored tickers first, then by ticker name.
    return Array.from(map.values()).sort((a, b) => {
      const aOpen = a.inFlight > 0 || a.errored > 0 ? 0 : 1;
      const bOpen = b.inFlight > 0 || b.errored > 0 ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return a.ticker.localeCompare(b.ticker);
    });
  })();
  const outstandingTickerCount = tickerProgress.filter(
    (t) => t.inFlight > 0 || t.errored > 0,
  ).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
            Fetch &amp; Review Filings
          </h1>
          <p className="text-sm text-muted-foreground">
            Select tickers and a date range, then fetch and render SEC filings as PDFs.{" "}
            {reviewEnabled
              ? "Newly rendered filings are automatically reviewed by Claude — findings show up in the Findings tab."
              : "Set ANTHROPIC_API_KEY to also have Claude review fetched filings for findings."}
          </p>
          {reviewEnabled && showSpend && usage && (usage.reviewedCount > 0 || usage.budgetUsd != null) && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-review-spend">
              Claude review spend so far:{" "}
              <span className="text-foreground font-medium">${usage.costUsd.toFixed(2)}</span>
              {usage.budgetUsd != null && (
                <>
                  {" "}
                  of <span className="text-foreground font-medium">${usage.budgetUsd.toFixed(2)}</span> cap
                </>
              )}
            </p>
          )}
        </div>
        {reviewEnabled && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={openBudgetDialog}
            data-testid="button-set-budget"
          >
            <Wallet className="w-3.5 h-3.5 mr-1.5" />
            {usage?.budgetUsd != null ? `Cap $${usage.budgetUsd.toFixed(0)}` : "Set cap"}
          </Button>
        )}
      </div>

      {/* Spend-cap paused notice */}
      {paused && usage && (
        <Card className="p-3 mb-6 flex items-center gap-2 border-amber-600/40" data-testid="card-review-paused">
          <PauseCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground flex-1">
            Review paused — the ${usage.budgetUsd?.toFixed(2)} spend cap has been reached (${usage.costUsd.toFixed(2)} spent).{" "}
            {usage.pendingCount} filing{usage.pendingCount !== 1 ? "s" : ""} still queued. Raise the cap to continue.
          </p>
          <Button size="sm" variant="secondary" onClick={openBudgetDialog} data-testid="button-raise-budget">
            Raise cap
          </Button>
        </Card>
      )}

      {/* Controls */}
      <Card className="p-5 mb-6">
        <div className="space-y-4">
          {/* Date Range Row */}
          <div>
            <label className="text-sm font-medium mb-2 block">Date Range</label>
            <div className="flex items-center gap-3">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-72 justify-start text-left font-normal"
                    data-testid="button-date-range"
                  >
                    <CalendarIcon className="w-4 h-4 mr-2 text-muted-foreground shrink-0" />
                    <span className={dateFrom || dateTo ? "" : "text-muted-foreground"}>
                      {rangeLabel}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="range"
                    numberOfMonths={2}
                    defaultMonth={dateRange?.from}
                    selected={dateRange}
                    onSelect={handleRangeSelect}
                    disabled={{ after: new Date() }}
                    initialFocus
                  />
                  <div className="flex justify-end border-t p-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => handleRangeSelect(undefined)}
                      data-testid="button-clear-date-range"
                    >
                      Clear
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <div className="flex items-center gap-2 ml-4">
                <label className="text-sm text-muted-foreground whitespace-nowrap">Max per ticker:</label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={limitPerTicker}
                  onChange={(e) => setLimitPerTicker(Number(e.target.value) || 5)}
                  className="w-20"
                  data-testid="input-limit"
                />
              </div>
            </div>
          </div>

          {/* Watchlist Filter */}
          <div>
            <label className="text-sm font-medium mb-2 block">Watchlist</label>
            <Select
              value={selectedWatchlist}
              onValueChange={(val) => {
                setSelectedWatchlist(val);
                setSelectedTickers(new Set());
              }}
            >
              <SelectTrigger className="w-60" data-testid="select-watchlist">
                <SelectValue placeholder="All tickers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tickers</SelectItem>
                {watchlists.map((wl) => (
                  <SelectItem key={wl.id} value={String(wl.id)}>
                    {wl.name} ({wl.tickerCount})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Ticker Selection */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-3">
              <label className="text-sm font-medium shrink-0">Tickers</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {selectedTickers.size} selected
                </span>
                <Button variant="ghost" size="sm" onClick={selectAll} className="text-xs h-7">
                  {tickerSearch.trim() ? "Select shown" : "Select all"}
                </Button>
                <Button variant="ghost" size="sm" onClick={selectNone} className="text-xs h-7">
                  Clear
                </Button>
              </div>
            </div>
            <div className="relative mb-2">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={tickerSearch}
                onChange={(e) => setTickerSearch(e.target.value)}
                placeholder="Filter tickers…"
                className="pl-8 h-9"
                data-testid="input-ticker-filter"
              />
            </div>
            <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto rounded-md border p-2">
              {visibleTickers.map((t: TickerInfo) => (
                <label
                  key={t.ticker}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border cursor-pointer transition-colors hover:bg-accent/50"
                  data-testid={`ticker-select-${t.ticker}`}
                >
                  <Checkbox
                    checked={selectedTickers.has(t.ticker)}
                    onCheckedChange={() => toggleTicker(t.ticker)}
                  />
                  <span className="text-sm font-mono font-medium">{t.ticker}</span>
                </label>
              ))}
              {displayTickers.length === 0 && (
                <p className="text-sm text-muted-foreground p-2">
                  No tickers in your watchlists. Add some first.
                </p>
              )}
              {displayTickers.length > 0 && visibleTickers.length === 0 && (
                <p className="text-sm text-muted-foreground p-2">No tickers match "{tickerSearch}".</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Showing {visibleTickers.length} of {displayTickers.length} ticker
              {displayTickers.length !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Fetch Button */}
          <Button
            onClick={handleFetch}
            disabled={selectedTickers.size === 0 || fetchMutation.isPending}
            className="w-full"
            data-testid="button-fetch-filings"
          >
            {fetchMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {reviewEnabled ? "Fetching, rendering & queuing review…" : "Fetching & rendering PDFs…"}
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                {reviewEnabled ? "Fetch, render & review" : "Fetch & render PDFs"} ({selectedTickers.size}{" "}
                ticker{selectedTickers.size !== 1 ? "s" : ""})
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* Claude review unavailable notice */}
      {config && !reviewEnabled && (
        <Card className="p-3 mb-4 flex items-center gap-2 border-amber-600/30" data-testid="card-review-disabled">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Claude review is off. Set <code className="text-foreground">ANTHROPIC_API_KEY</code> in the
            environment to have filings reviewed for footnoted-worthy findings.
          </p>
        </Card>
      )}

      {/* Results */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          Rendered PDFs
          {completedFilings.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({completedFilings.length} available)
            </span>
          )}
        </h2>
        {completedFilings.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => renderMissingMutation.mutate()}
            disabled={renderMissingMutation.isPending}
            title="Regenerate PDFs that show 'Review error: Rendered PDF not found'"
            data-testid="button-render-missing"
          >
            {renderMissingMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            )}
            Re-render missing PDFs
          </Button>
        )}
      </div>

      {showReviewBanner && (
        <Card className="p-4 mb-4 space-y-3" data-testid="card-review-summary">
          {/* Header: status + live spend */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              {paused ? (
                <PauseCircle className="w-4 h-4 text-amber-400 shrink-0" />
              ) : runActive ? (
                <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              ) : reviewErrorCount > 0 || renderErrorCount > 0 ? (
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-green-400 shrink-0" />
              )}
              <p className="text-sm font-medium">
                {paused
                  ? `Review paused — ${usage?.budgetUsd != null ? `$${usage.budgetUsd.toFixed(2)} ` : ""}spend cap reached`
                  : runActive
                    ? renderingCount > 0
                      ? "Fetching, rendering & reviewing…"
                      : "Reviewing filings…"
                    : "Last run complete"}
              </p>
              {paused && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6"
                  onClick={openBudgetDialog}
                  data-testid="button-raise-cap-inline"
                >
                  Raise cap
                </Button>
              )}
            </div>
            {usage && (
              <div className="flex items-center gap-1 shrink-0">
                <p className="text-xs text-muted-foreground whitespace-nowrap">
                  {showSpend ? (
                    <>
                      Spend{" "}
                      <span className="text-foreground font-medium">${usage.costUsd.toFixed(2)}</span>
                      {usage.budgetUsd != null && <> / ${usage.budgetUsd.toFixed(2)} cap</>}
                    </>
                  ) : (
                    "Spend hidden"
                  )}
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground"
                  onClick={toggleSpend}
                  aria-label={showSpend ? "Hide spend" : "Show spend"}
                  data-testid="toggle-spend"
                >
                  {showSpend ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </Button>
              </div>
            )}
          </div>

          {/* Review progress bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
              <span>
                Reviewed <span className="text-foreground font-medium">{reviewedCount}</span> of{" "}
                {reviewableTotal} rendered filing{reviewableTotal !== 1 ? "s" : ""}
              </span>
              <span>{reviewProgressPct}%</span>
            </div>
            <Progress value={reviewProgressPct} className="h-2" />
          </div>

          {/* Count chips */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="text-green-400">✓ {reviewedCount} reviewed</span>
            {reviewingNowCount > 0 && (
              <span className="text-amber-400">⟳ {reviewingNowCount} reviewing</span>
            )}
            {queuedCount > 0 && <span className="text-amber-400">◷ {queuedCount} queued</span>}
            {reviewErrorCount > 0 && (
              <span className="text-red-400">⚠ {reviewErrorCount} review error{reviewErrorCount !== 1 ? "s" : ""}</span>
            )}
            {renderingCount > 0 && (
              <span className="text-muted-foreground">{renderingCount} rendering</span>
            )}
            {renderErrorCount > 0 && (
              <span className="text-red-400">{renderErrorCount} render error{renderErrorCount !== 1 ? "s" : ""}</span>
            )}
          </div>

          {/* What-to-do-next when the spend cap pauses the queue */}
          {paused && (
            <p className="text-xs text-muted-foreground">
              {queuedCount} filing{queuedCount !== 1 ? "s are" : " is"} held and won't be reviewed until you{" "}
              <button
                type="button"
                onClick={openBudgetDialog}
                className="text-primary hover:underline"
                data-testid="link-raise-cap"
              >
                raise or remove the spend cap
              </button>
              . Already-reviewed findings are saved.
            </p>
          )}

          {/* Findings link */}
          {totalFindings > 0 && (
            <p className="text-xs text-muted-foreground">
              <ShieldAlert className="w-3.5 h-3.5 inline -mt-0.5 mr-1 text-amber-400" />
              <span className="text-foreground font-medium">{totalFindings}</span> finding
              {totalFindings !== 1 ? "s" : ""} across {interestingCount} filing
              {interestingCount !== 1 ? "s" : ""} ·{" "}
              <Link href="/" className="text-primary hover:underline">
                View in Findings
              </Link>
            </p>
          )}

          {/* Per-ticker progress */}
          {tickerProgress.length > 0 && (
            <Collapsible open={tickerListOpen} onOpenChange={setTickerListOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="toggle-ticker-progress">
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${tickerListOpen ? "" : "-rotate-90"}`}
                />
                Per-ticker progress ({tickerProgress.length} ticker{tickerProgress.length !== 1 ? "s" : ""}
                {outstandingTickerCount > 0 ? `, ${outstandingTickerCount} outstanding` : ""})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 max-h-64 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 pr-1">
                  {tickerProgress.map((t) => {
                    const done = t.errored === 0 && t.inFlight === 0;
                    return (
                      <div
                        key={t.ticker}
                        className="flex items-center justify-between gap-2 text-xs"
                        data-testid={`ticker-progress-${t.ticker}`}
                      >
                        <span className="font-mono truncate">{t.ticker}</span>
                        <span className="flex items-center gap-1.5 shrink-0 tabular-nums">
                          <span className="text-muted-foreground">
                            {t.reviewed}/{t.total}
                          </span>
                          {t.errored > 0 ? (
                            <span className="text-red-400">⚠{t.errored}</span>
                          ) : t.inFlight > 0 ? (
                            <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />
                          ) : done ? (
                            <Check className="w-3 h-3 text-green-400" />
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </Card>
      )}

      {filteredFilings.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <FileText className="w-6 h-6 text-primary" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            No filings yet. Select tickers and a date range above, then fetch.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredFilings.map((f) => (
            <Card
              key={f.id}
              className="p-4 flex items-center gap-4"
              data-testid={`filing-${f.accessionNumber}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold font-mono">{f.ticker}</span>
                  <Badge variant="secondary" className="text-xs">{f.filingType}</Badge>
                  {f.filingDate && (
                    <span className="text-xs text-muted-foreground">{f.filingDate}</span>
                  )}
                  {f.status === "complete" && (
                    <Badge variant="default" className="text-xs bg-green-600/20 text-green-400 border-green-600/30">
                      <Check className="w-3 h-3 mr-0.5" /> Ready
                    </Badge>
                  )}
                  {f.status === "rendering" && (
                    <Badge variant="default" className="text-xs bg-yellow-600/20 text-yellow-400 border-yellow-600/30">
                      <Loader2 className="w-3 h-3 mr-0.5 animate-spin" /> Rendering
                    </Badge>
                  )}
                  {f.status === "error" && (
                    <Badge variant="destructive" className="text-xs">
                      <X className="w-3 h-3 mr-0.5" /> Error
                    </Badge>
                  )}
                  {(f.reviewStatus === "pending" || f.reviewStatus === "reviewing") && (
                    <Badge variant="default" className="text-xs bg-amber-600/20 text-amber-400 border-amber-600/30">
                      <Loader2 className="w-3 h-3 mr-0.5 animate-spin" /> Reading
                    </Badge>
                  )}
                  {f.reviewStatus === "done" && f.reviewFlagged && (() => {
                    const n = parseFindings(f).length;
                    const high = f.reviewMateriality === "high";
                    return (
                      <Badge
                        variant="default"
                        className={`text-xs ${high ? "bg-red-600/20 text-red-400 border-red-600/30" : "bg-amber-600/20 text-amber-400 border-amber-600/30"}`}
                      >
                        <ShieldAlert className="w-3 h-3 mr-0.5" />
                        {n} finding{n !== 1 ? "s" : ""}
                        {f.reviewMateriality && f.reviewMateriality !== "none" ? ` · ${f.reviewMateriality} interest` : ""}
                      </Badge>
                    );
                  })()}
                  {f.reviewStatus === "done" && !f.reviewFlagged && (
                    <Badge variant="secondary" className="text-xs text-muted-foreground">
                      <ShieldCheck className="w-3 h-3 mr-0.5" /> Nothing notable
                    </Badge>
                  )}
                  {f.reviewStatus === "error" && (
                    <span className="inline-flex items-center gap-1">
                      <Badge
                        variant="secondary"
                        className="text-xs text-muted-foreground"
                        title={f.reviewError || undefined}
                      >
                        <AlertCircle className="w-3 h-3 mr-0.5" /> Review error
                      </Badge>
                      {reviewEnabled && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-[11px] text-muted-foreground"
                          onClick={() => retryReviewMutation.mutate(f.accessionNumber)}
                          disabled={retryReviewMutation.isPending}
                          data-testid={`retry-review-${f.accessionNumber}`}
                        >
                          Retry
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{f.accessionNumber}</span>
                  {f.pdfSize && (
                    <span>{(f.pdfSize / 1024 / 1024).toFixed(1)} MB</span>
                  )}
                </div>
                {f.reviewStatus === "error" && f.reviewError && (
                  <p className="text-xs text-muted-foreground/80 mt-1">Review error: {f.reviewError}</p>
                )}
                {f.reviewStatus === "done" && f.reviewFlagged && f.reviewSummary && (
                  <p
                    className="text-xs mt-1.5 text-amber-300/90 font-medium"
                    data-testid={`review-summary-${f.accessionNumber}`}
                  >
                    {f.reviewSummary}
                  </p>
                )}
                {f.reviewStatus === "done" && parseFindings(f).length > 0 && (
                  <div className="mt-2 space-y-2" data-testid={`review-findings-${f.accessionNumber}`}>
                    {parseFindings(f).map((finding, i) => (
                      <div key={i} className="rounded-md border border-border/60 bg-muted/30 p-2.5">
                        <div className="flex items-center gap-2 mb-0.5">
                          <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                            {CATEGORY_LABELS[finding.category] || finding.category}
                          </Badge>
                          <span className="text-xs font-semibold">{finding.headline}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{finding.detail}</p>
                        {finding.why && (
                          <p className="text-xs text-muted-foreground/80 italic mt-0.5">{finding.why}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {f.status === "complete" && f.pdfPath && (
                <a
                  href={`${API_BASE}/api/filings/${encodeURIComponent(f.accessionNumber)}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button size="sm" data-testid={`download-${f.accessionNumber}`}>
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    Download
                  </Button>
                </a>
              )}
              {f.status === "error" && f.errorMessage && (
                <span className="text-xs text-destructive max-w-48 truncate" title={f.errorMessage}>
                  {f.errorMessage}
                </span>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Confirmation for large / costly batches */}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirm?.action();
                setConfirm(null);
              }}
              data-testid="button-confirm-batch"
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Claude spend cap editor */}
      <Dialog open={budgetOpen} onOpenChange={setBudgetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Claude review spend cap</DialogTitle>
            <DialogDescription>
              Set a maximum total Claude cost for fetching &amp; reviewing filings. When cumulative
              spend reaches this cap, the auto-review queue pauses and remaining filings stay queued
              until you raise it. This does not affect the Compare feature. Leave blank to remove the cap.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveBudget();
            }}
          >
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <Input
                type="number"
                min="0"
                step="1"
                placeholder="e.g. 50"
                className="pl-6"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                autoFocus
                data-testid="input-budget"
              />
            </div>
            {usage && (
              <p className="text-xs text-muted-foreground mt-2">
                Spent so far: <span className="text-foreground font-medium">${usage.costUsd.toFixed(2)}</span>
                {usage.pendingCount > 0 && <> · {usage.pendingCount} filing{usage.pendingCount !== 1 ? "s" : ""} queued</>}
              </p>
            )}
            <DialogFooter className="mt-4">
              {usage?.budgetUsd != null && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => budgetMutation.mutate(null)}
                  disabled={budgetMutation.isPending}
                  data-testid="button-clear-budget"
                >
                  Remove cap
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => setBudgetOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={budgetMutation.isPending} data-testid="button-save-budget">
                {budgetMutation.isPending ? "Saving…" : "Save cap"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
