import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
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
import { GitCompareArrows, Loader2, AlertCircle, Plus, Minus, Pencil } from "lucide-react";
import type { Filing } from "@shared/schema";

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

export default function Compare() {
  const { data: filings = [] } = useQuery<Filing[]>({ queryKey: ["/api/filings"] });
  const { data: config } = useQuery<{ reviewEnabled: boolean }>({ queryKey: ["/api/config"] });
  const reviewEnabled = config?.reviewEnabled ?? false;

  const completeFilings = useMemo(
    () => filings.filter((f) => f.status === "complete" && f.pdfPath),
    [filings],
  );

  const tickers = useMemo(
    () => Array.from(new Set(completeFilings.map((f) => f.ticker))).sort(),
    [completeFilings],
  );

  const [ticker, setTicker] = useState<string>("");
  const [accA, setAccA] = useState<string>("");
  const [accB, setAccB] = useState<string>("");
  const [section, setSection] = useState<string>("risk_factors");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Filings for the chosen ticker, newest first
  const tickerFilings = useMemo(
    () =>
      completeFilings
        .filter((f) => f.ticker === ticker)
        .sort((a, b) => (b.filingDate || "").localeCompare(a.filingDate || "")),
    [completeFilings, ticker],
  );

  // When the ticker changes, default to the two most recent filings
  useEffect(() => {
    if (tickerFilings.length >= 2) {
      setAccB(tickerFilings[0].accessionNumber);
      setAccA(tickerFilings[1].accessionNumber);
    } else {
      setAccA("");
      setAccB("");
    }
    setResult(null);
  }, [ticker]); // eslint-disable-line react-hooks/exhaustive-deps

  const compareMutation = useMutation<CompareResult>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/compare", {
        accessionA: accA,
        accessionB: accB,
        section,
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Comparison failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      setShowDiff(false);
    },
  });

  const filingLabel = (f: Filing) => `${f.filingType} · ${f.filingDate || "?"}`;
  const canCompare = ticker && accA && accB && accA !== accB && reviewEnabled;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
          Compare Filings
        </h1>
        <p className="text-sm text-muted-foreground">
          Diff a section (e.g. Risk Factors) between two filings of the same company to see what changed.
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
        <div>
          <label className="text-sm font-medium mb-1.5 block">Company</label>
          <Select value={ticker} onValueChange={setTicker}>
            <SelectTrigger className="w-60" data-testid="select-compare-ticker">
              <SelectValue placeholder="Select a ticker" />
            </SelectTrigger>
            <SelectContent>
              {tickers.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {tickers.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              No rendered filings yet. Fetch some on the Fetch Filings page first.
            </p>
          )}
        </div>

        {ticker && (
          <>
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
                Need at least two rendered filings for {ticker} to compare.
              </p>
            )}

            <div>
              <label className="text-sm font-medium mb-1.5 block">Section</label>
              <Select value={section} onValueChange={setSection}>
                <SelectTrigger className="w-60" data-testid="select-compare-section">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SECTIONS.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={() => compareMutation.mutate()}
              disabled={!canCompare || compareMutation.isPending}
              data-testid="button-compare"
            >
              {compareMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Comparing…
                </>
              ) : (
                <>
                  <GitCompareArrows className="w-4 h-4 mr-2" />
                  Compare {SECTIONS.find((s) => s.key === section)?.label}
                </>
              )}
            </Button>
          </>
        )}
      </Card>

      {compareMutation.isError && (
        <Card className="p-4 mb-4 border-destructive/40">
          <p className="text-sm text-destructive">{(compareMutation.error as Error)?.message}</p>
        </Card>
      )}

      {result && (
        <div className="space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className="font-semibold">{result.sectionLabel}</span>
            <Badge variant="outline">
              {result.earlier.form} {result.earlier.date}
            </Badge>
            <span className="text-muted-foreground">→</span>
            <Badge variant="outline">
              {result.later.form} {result.later.date}
            </Badge>
            {result.costUsd > 0 && (
              <span className="text-xs text-muted-foreground">· ${result.costUsd.toFixed(2)}</span>
            )}
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

              {result.changelog.unchanged &&
                result.changelog.added.length === 0 &&
                result.changelog.removed.length === 0 &&
                result.changelog.changed.length === 0 && (
                  <Card className="p-4 text-sm text-muted-foreground">
                    No material changes detected in this section.
                  </Card>
                )}

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
                onClick={() => setShowDiff((v) => !v)}
                data-testid="button-toggle-diff"
              >
                {showDiff ? "Hide" : "Show"} literal text diff
              </button>
              {showDiff && (
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
      )}
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
