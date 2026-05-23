import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { useToast } from "@/hooks/use-toast";
import {
  GitCompareArrows,
  Loader2,
  AlertCircle,
  Plus,
  Minus,
  Pencil,
  Check,
  ChevronsUpDown,
  History,
} from "lucide-react";
import type { Filing } from "@shared/schema";
import { estimateReviewCost, formatCostRange } from "@/lib/findings";

type TickerInfo = { ticker: string; cik: string; filingTypes: string[] };
type DiffSegment = { value: string; added?: boolean; removed?: boolean };
type ChangeItem = { headline: string; detail: string };
type Changelog = {
  unchanged: boolean;
  summary: string;
  added: ChangeItem[];
  removed: ChangeItem[];
  changed: ChangeItem[];
};
type CompareResult = {
  section: string;
  sectionLabel: string;
  earlier: { accession: string; ticker: string; form: string; date: string; found: boolean };
  later: { accession: string; ticker: string; form: string; date: string; found: boolean };
  diff: DiffSegment[] | null;
  changelog: Changelog | null;
  costUsd: number;
  note?: string;
};

const SECTIONS = [
  { key: "risk_factors", label: "Risk Factors" },
  { key: "mdna", label: "MD&A" },
  { key: "legal", label: "Legal Proceedings" },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);

// Forms that contain the comparable sections (excludes 8-K)
const HISTORY_FORMS = ["10-K", "10-Q", "DEF 14A"];
const HISTORY_LIMIT = 30;
const HISTORY_YEARS = 3;

function historyStartDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - HISTORY_YEARS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Compare() {
  const { toast } = useToast();
  const { data: allTickers = [] } = useQuery<TickerInfo[]>({ queryKey: ["/api/all-tickers"] });
  const { data: filings = [] } = useQuery<Filing[]>({ queryKey: ["/api/filings"] });
  const { data: config } = useQuery<{ reviewEnabled: boolean }>({ queryKey: ["/api/config"] });
  const reviewEnabled = config?.reviewEnabled ?? false;

  const completeFilings = useMemo(
    () => filings.filter((f) => f.status === "complete" && f.pdfPath),
    [filings],
  );

  const [ticker, setTicker] = useState<string>("");
  const [tickerOpen, setTickerOpen] = useState(false);
  const [accA, setAccA] = useState<string>("");
  const [accB, setAccB] = useState<string>("");
  const [section, setSection] = useState<string>("all");
  const [results, setResults] = useState<CompareResult[]>([]);
  const [sectionErrors, setSectionErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set());
  const [confirmLoad, setConfirmLoad] = useState(false);

  const tickerFilings = useMemo(
    () =>
      completeFilings
        .filter((f) => f.ticker === ticker)
        .sort((a, b) => (b.filingDate || "").localeCompare(a.filingDate || "")),
    [completeFilings, ticker],
  );

  useEffect(() => {
    if (tickerFilings.length >= 2) {
      setAccB(tickerFilings[0].accessionNumber);
      setAccA(tickerFilings[1].accessionNumber);
    } else {
      setAccA("");
      setAccB("");
    }
    setResults([]);
    setSectionErrors([]);
  }, [ticker]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedEntry = allTickers.find((t) => t.ticker === ticker);

  // Load the last few years of comparable filings for this ticker into the library
  const loadHistoryMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEntry) throw new Error("Pick a ticker first");
      const res = await apiRequest("POST", "/api/filings/fetch", {
        tickers: [{ ticker: selectedEntry.ticker, cik: selectedEntry.cik, filing_types: HISTORY_FORMS }],
        dateFrom: historyStartDate(),
        limitPerTicker: HISTORY_LIMIT,
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to load history");
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/filings"] });
      const parts: string[] = [];
      if (data.totalRendered > 0) parts.push(`${data.totalRendered} new`);
      if (data.totalSkipped > 0) parts.push(`${data.totalSkipped} already had`);
      toast({ title: "History loaded", description: parts.join(", ") || "No new filings found" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const runCompare = async () => {
    if (!accA || !accB || accA === accB) return;
    setRunning(true);
    setResults([]);
    setSectionErrors([]);
    const secs = section === "all" ? SECTION_KEYS : [section];
    for (const sec of secs) {
      try {
        const res = await apiRequest("POST", "/api/compare", {
          accessionA: accA,
          accessionB: accB,
          section: sec,
        });
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error || "Comparison failed");
        }
        const data: CompareResult = await res.json();
        setResults((prev) => [...prev, data]);
      } catch (e: any) {
        const label = SECTIONS.find((s) => s.key === sec)?.label || sec;
        setSectionErrors((prev) => [...prev, `${label}: ${e.message}`]);
      }
    }
    setRunning(false);
  };

  const filingLabel = (f: Filing) => `${f.filingType} · ${f.filingDate || "?"}`;
  const canCompare = !!ticker && !!accA && !!accB && accA !== accB && reviewEnabled && !running;
  const totalCost = results.reduce((n, r) => n + (r.costUsd || 0), 0);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
          Compare Filings
        </h1>
        <p className="text-sm text-muted-foreground">
          Diff a section (or all of them) between two filings of the same company to see what changed.
        </p>
      </div>

      {config && !reviewEnabled && (
        <Card className="p-3 mb-4 flex items-center gap-2 border-amber-600/30">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Comparison uses Claude. Set <code className="text-foreground">ANTHROPIC_API_KEY</code> to enable it.
          </p>
        </Card>
      )}

      {/* Controls */}
      <Card className="p-5 mb-6 space-y-4">
        {/* Ticker search */}
        <div>
          <label className="text-sm font-medium mb-1.5 block">Company</label>
          <Popover open={tickerOpen} onOpenChange={setTickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                className="w-72 justify-between font-mono"
                data-testid="button-ticker-search"
              >
                {ticker || <span className="text-muted-foreground font-sans">Search ticker…</span>}
                <ChevronsUpDown className="w-4 h-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search ticker…" data-testid="input-ticker-search" />
                <CommandList>
                  <CommandEmpty>No ticker found.</CommandEmpty>
                  <CommandGroup>
                    {allTickers.map((t) => (
                      <CommandItem
                        key={t.ticker}
                        value={t.ticker}
                        onSelect={() => {
                          setTicker(t.ticker);
                          setTickerOpen(false);
                        }}
                      >
                        <Check className={`mr-2 h-4 w-4 ${ticker === t.ticker ? "opacity-100" : "opacity-0"}`} />
                        <span className="font-mono">{t.ticker}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {ticker && (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-muted-foreground">
                {tickerFilings.length} rendered filing{tickerFilings.length !== 1 ? "s" : ""} for {ticker}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmLoad(true)}
                disabled={loadHistoryMutation.isPending || !selectedEntry}
                data-testid="button-load-history"
              >
                {loadHistoryMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <History className="w-3.5 h-3.5 mr-1.5" />
                )}
                Load last 3 years
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Filing A</label>
                <Select value={accA} onValueChange={setAccA}>
                  <SelectTrigger data-testid="select-compare-a">
                    <SelectValue placeholder="Select filing" />
                  </SelectTrigger>
                  <SelectContent>
                    {tickerFilings.map((f) => (
                      <SelectItem key={f.accessionNumber} value={f.accessionNumber}>
                        {filingLabel(f)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Filing B</label>
                <Select value={accB} onValueChange={setAccB}>
                  <SelectTrigger data-testid="select-compare-b">
                    <SelectValue placeholder="Select filing" />
                  </SelectTrigger>
                  <SelectContent>
                    {tickerFilings.map((f) => (
                      <SelectItem key={f.accessionNumber} value={f.accessionNumber}>
                        {filingLabel(f)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {tickerFilings.length < 2 && (
              <p className="text-xs text-muted-foreground">
                Need at least two rendered filings for {ticker}. Use “Load last 3 years” to pull more history.
              </p>
            )}

            <div>
              <label className="text-sm font-medium mb-1.5 block">Section</label>
              <Select value={section} onValueChange={setSection}>
                <SelectTrigger className="w-60" data-testid="select-compare-section">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sections</SelectItem>
                  {SECTIONS.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button onClick={runCompare} disabled={!canCompare} data-testid="button-compare">
              {running ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Comparing…
                </>
              ) : (
                <>
                  <GitCompareArrows className="w-4 h-4 mr-2" />
                  Compare {section === "all" ? "all sections" : SECTIONS.find((s) => s.key === section)?.label}
                </>
              )}
            </Button>
          </>
        )}
      </Card>

      {(results.length > 0 || sectionErrors.length > 0 || running) && (
        <div className="space-y-6">
          {totalCost > 0 && (
            <p className="text-xs text-muted-foreground">Comparison cost so far: ${totalCost.toFixed(2)}</p>
          )}
          {results.map((result) => (
            <div key={result.section} className="space-y-3">
              <div className="flex items-center gap-2 text-sm flex-wrap border-b pb-2">
                <span className="font-semibold">{result.sectionLabel}</span>
                <Badge variant="outline">
                  {result.earlier.form} {result.earlier.date}
                </Badge>
                <span className="text-muted-foreground">→</span>
                <Badge variant="outline">
                  {result.later.form} {result.later.date}
                </Badge>
              </div>

              {result.note && (
                <Card className="p-4 border-amber-600/30">
                  <p className="text-sm text-muted-foreground">{result.note}</p>
                </Card>
              )}

              {result.changelog && (
                <>
                  <Card className="p-4">
                    <p className="text-sm">{result.changelog.summary}</p>
                  </Card>
                  {result.changelog.added.length > 0 && (
                    <ChangeGroup title="Added" icon={<Plus className="w-3.5 h-3.5 text-green-400" />} items={result.changelog.added} />
                  )}
                  {result.changelog.removed.length > 0 && (
                    <ChangeGroup title="Removed" icon={<Minus className="w-3.5 h-3.5 text-red-400" />} items={result.changelog.removed} />
                  )}
                  {result.changelog.changed.length > 0 && (
                    <ChangeGroup title="Changed" icon={<Pencil className="w-3.5 h-3.5 text-amber-400" />} items={result.changelog.changed} />
                  )}
                </>
              )}

              {result.diff && result.diff.length > 0 && (
                <Card className="p-4">
                  <button
                    className="text-sm font-medium mb-2 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setOpenDiffs((prev) => {
                        const next = new Set(prev);
                        if (next.has(result.section)) next.delete(result.section);
                        else next.add(result.section);
                        return next;
                      })
                    }
                  >
                    {openDiffs.has(result.section) ? "Hide" : "Show"} literal text diff
                  </button>
                  {openDiffs.has(result.section) && (
                    <pre className="text-xs whitespace-pre-wrap leading-relaxed max-h-[28rem] overflow-auto rounded-md border p-3">
                      {result.diff.map((seg, i) => (
                        <span
                          key={i}
                          className={
                            seg.added
                              ? "bg-green-600/20 text-green-300"
                              : seg.removed
                                ? "bg-red-600/20 text-red-300 line-through"
                                : "text-muted-foreground"
                          }
                        >
                          {seg.value}
                        </span>
                      ))}
                    </pre>
                  )}
                </Card>
              )}
            </div>
          ))}

          {running && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Comparing{section === "all" ? ` (${results.length + sectionErrors.length}/${SECTION_KEYS.length})` : ""}…
            </div>
          )}

          {sectionErrors.map((err, i) => (
            <Card key={i} className="p-3 border-destructive/40">
              <p className="text-sm text-destructive">{err}</p>
            </Card>
          ))}
        </div>
      )}

      {/* Load-history confirmation */}
      <AlertDialog open={confirmLoad} onOpenChange={setConfirmLoad}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Load {HISTORY_YEARS} years of {ticker} filings?</AlertDialogTitle>
            <AlertDialogDescription>
              Fetches and renders up to {HISTORY_LIMIT} recent {HISTORY_FORMS.join(" / ")} filings from the
              last {HISTORY_YEARS} years. New ones are reviewed by Claude
              {reviewEnabled
                ? ` (estimated cost up to ${formatCostRange(estimateReviewCost(Array(HISTORY_LIMIT).fill("10-K")))})`
                : ""}
              . It can take a minute.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmLoad(false);
                loadHistoryMutation.mutate();
              }}
              data-testid="button-confirm-load-history"
            >
              Load
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ChangeGroup({ title, icon, items }: { title: string; icon: React.ReactNode; items: ChangeItem[] }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <span className="text-sm font-semibold">
          {title} ({items.length})
        </span>
      </div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="rounded-md border border-border/60 bg-muted/30 p-2.5">
            <p className="text-sm font-medium">{it.headline}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{it.detail}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}
