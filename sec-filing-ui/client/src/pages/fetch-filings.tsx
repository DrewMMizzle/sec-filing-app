import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, API_BASE } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { useToast } from "@/hooks/use-toast";
import { Search, Download, Loader2, FileText, Calendar as CalendarIcon, Check, X, AlertCircle, ShieldAlert, ShieldCheck, RefreshCw } from "lucide-react";
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

  // Current Claude spend cap, so we can warn before a big run and flag pauses.
  const { data: usage } = useQuery<{
    costUsd: number;
    budgetUsd: number | null;
    pendingCount: number;
    paused: boolean;
  }>({
    queryKey: ["/api/review/usage"],
  });

  const { data: existingFilings = [], refetch: refetchFilings } = useQuery<Filing[]>({
    queryKey: ["/api/filings"],
    // While Claude is reviewing filings, poll so flags appear as they complete.
    refetchInterval: (query) => {
      const rows = query.state.data as Filing[] | undefined;
      const reviewing = rows?.some(
        (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
      );
      return reviewing ? 4000 : false;
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
    onSuccess: (data) => {
      refetchFilings();
      const parts: string[] = [];
      if (data.totalRendered > 0) parts.push(`${data.totalRendered} new PDF(s) rendered`);
      if (data.totalSkipped > 0) parts.push(`${data.totalSkipped} already in library`);
      if (data.totalErrors > 0) parts.push(`${data.totalErrors} error(s)`);
      if (parts.length === 0) parts.push("No new filings found in range");
      toast({
        title: `Fetch complete`,
        description: parts.join(", "),
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
            ? " Tip: set a spend cap on the Findings page to stop reviews automatically at a dollar limit."
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

  // Footnoted-style review summary across the currently-shown filings
  const reviewingCount = filteredFilings.filter(
    (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
  ).length;
  const reviewedFilings = filteredFilings.filter((f) => f.reviewStatus === "done");
  const interestingCount = reviewedFilings.filter((f) => f.reviewFlagged).length;
  const totalFindings = reviewedFilings.reduce((n, f) => n + parseFindings(f).length, 0);
  const showReviewBanner = reviewingCount > 0 || reviewedFilings.length > 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
          Fetch &amp; Review Filings
        </h1>
        <p className="text-sm text-muted-foreground">
          Select tickers and a date range, then fetch and render SEC filings as PDFs.{" "}
          {reviewEnabled
            ? "Newly rendered filings are automatically reviewed by Claude — findings show up in the Findings tab."
            : "Set ANTHROPIC_API_KEY to also have Claude review fetched filings for findings."}
        </p>
      </div>

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
        <Card className="p-4 mb-4 flex items-center gap-3" data-testid="card-review-summary">
          {reviewingCount > 0 ? (
            <>
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              <p className="text-sm">
                Claude is digging through filings for footnoted-worthy items —{" "}
                <span className="font-medium">{reviewedFilings.length} done</span>,{" "}
                {reviewingCount} in progress
                {totalFindings > 0 && <> ({totalFindings} finding{totalFindings !== 1 ? "s" : ""} so far)</>}
              </p>
            </>
          ) : totalFindings > 0 ? (
            <>
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <p className="text-sm">
                Claude surfaced <span className="font-medium">{totalFindings}</span> post-worthy finding
                {totalFindings !== 1 ? "s" : ""} across{" "}
                <span className="font-medium">{interestingCount}</span> of {reviewedFilings.length} filing
                {reviewedFilings.length !== 1 ? "s" : ""}.
              </p>
            </>
          ) : (
            <>
              <ShieldCheck className="w-4 h-4 text-green-400 shrink-0" />
              <p className="text-sm">
                Claude read {reviewedFilings.length} filing{reviewedFilings.length !== 1 ? "s" : ""} —
                nothing notable found.
              </p>
            </>
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
    </div>
  );
}
