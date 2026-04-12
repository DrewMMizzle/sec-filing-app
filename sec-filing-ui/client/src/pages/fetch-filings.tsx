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
import { useToast } from "@/hooks/use-toast";
import { Search, Download, Loader2, FileText, Calendar, Check, X, AlertCircle } from "lucide-react";
import type { Filing } from "@shared/schema";

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

  // Date range state
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Ticker selection state
  const [selectedWatchlist, setSelectedWatchlist] = useState<string>("all");
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(new Set());
  const [limitPerTicker, setLimitPerTicker] = useState(5);

  // Queries
  const { data: allTickers = [] } = useQuery<TickerInfo[]>({
    queryKey: ["/api/all-tickers"],
  });

  const { data: watchlists = [] } = useQuery<WatchlistSummary[]>({
    queryKey: ["/api/watchlists"],
  });

  const { data: existingFilings = [], refetch: refetchFilings } = useQuery<Filing[]>({
    queryKey: ["/api/filings"],
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
    setSelectedTickers(new Set(displayTickers.map((t: TickerInfo) => t.ticker)));
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

  const handleFetch = () => {
    if (selectedTickers.size === 0) {
      toast({ title: "Select at least one ticker", variant: "destructive" });
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

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
          Fetch Filings
        </h1>
        <p className="text-sm text-muted-foreground">
          Select tickers and a date range, then fetch and render SEC filings as PDFs.
        </p>
      </div>

      {/* Controls */}
      <Card className="p-5 mb-6">
        <div className="space-y-4">
          {/* Date Range Row */}
          <div>
            <label className="text-sm font-medium mb-2 block">Date Range</label>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-40"
                  data-testid="input-date-from"
                />
              </div>
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-40"
                data-testid="input-date-to"
              />
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
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">Tickers</label>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={selectAll} className="text-xs h-7">
                  Select All
                </Button>
                <Button variant="ghost" size="sm" onClick={selectNone} className="text-xs h-7">
                  Clear
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {displayTickers.map((t: TickerInfo) => (
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
                <p className="text-sm text-muted-foreground">
                  No tickers in your watchlists. Add some first.
                </p>
              )}
            </div>
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
                Fetching & Rendering PDFs...
              </>
            ) : (
              <>
                <Search className="w-4 h-4 mr-2" />
                Fetch & Render PDFs ({selectedTickers.size} ticker{selectedTickers.size !== 1 ? "s" : ""})
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* Results */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Rendered PDFs
          {completedFilings.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({completedFilings.length} available)
            </span>
          )}
        </h2>
      </div>

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
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{f.accessionNumber}</span>
                  {f.pdfSize && (
                    <span>{(f.pdfSize / 1024 / 1024).toFixed(1)} MB</span>
                  )}
                </div>
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
    </div>
  );
}
