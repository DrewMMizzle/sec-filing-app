import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { LineChart, Loader2, AlertCircle, ChevronDown, ChevronRight, RefreshCw, Sparkles } from "lucide-react";

type RevenueDriver = { factor: string; impact: string; detail: string };
type Segment = { name: string; revenue: string; profit: string; commentary: string };
type MdnaDigest = {
  available: boolean;
  period: string;
  overview: string;
  revenue_drivers: RevenueDriver[];
  margins: { gross: string; operating: string; commentary: string };
  segments: Segment[];
  guidance: string;
  other: string[];
};

type MdnaItem = {
  accession: string;
  ticker: string;
  form: string;
  date: string | null;
  mdnaStatus: string | null;
  analyzedAt: string | null;
  error: string | null;
  costUsd: number | null;
  digest: MdnaDigest | null;
};

type GenerateResponse = { digest: MdnaDigest; costUsd: number; analyzedAt: string };

function Field({ label, value }: { label: string; value: string }) {
  if (!value || !value.trim()) return null;
  return (
    <div>
      <span className="text-xs font-semibold text-muted-foreground">{label}: </span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function DigestView({ digest }: { digest: MdnaDigest }) {
  if (!digest.available) {
    return (
      <p className="text-sm text-muted-foreground">
        No MD&amp;A operational detail was found in this filing.
      </p>
    );
  }
  const { revenue_drivers, margins, segments, other } = digest;
  const hasMargins = margins.gross || margins.operating || margins.commentary;
  return (
    <div className="space-y-4">
      {digest.overview && (
        <p className="text-sm leading-relaxed">{digest.overview}</p>
      )}

      {revenue_drivers.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Revenue drivers
          </p>
          <div className="space-y-1.5">
            {revenue_drivers.map((d, i) => (
              <div key={i} className="text-sm flex gap-2">
                <Badge variant="secondary" className="shrink-0 capitalize">{d.factor}</Badge>
                <span>
                  {d.impact && <span className="font-medium">{d.impact}</span>}
                  {d.impact && d.detail && " — "}
                  {d.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasMargins && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Margins
          </p>
          <div className="space-y-1">
            <Field label="Gross" value={margins.gross} />
            <Field label="Operating" value={margins.operating} />
            <Field label="Notes" value={margins.commentary} />
          </div>
        </div>
      )}

      {segments.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Segments
          </p>
          <div className="space-y-2">
            {segments.map((s, i) => (
              <div key={i} className="text-sm border-l-2 border-border pl-3">
                <p className="font-medium">{s.name}</p>
                <Field label="Revenue" value={s.revenue} />
                <Field label="Profit" value={s.profit} />
                {s.commentary && <p className="text-muted-foreground">{s.commentary}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {digest.guidance && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Guidance / outlook
          </p>
          <p className="text-sm leading-relaxed">{digest.guidance}</p>
        </div>
      )}

      {other.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            Other
          </p>
          <ul className="list-disc pl-5 space-y-1">
            {other.map((o, i) => (
              <li key={i} className="text-sm">{o}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Mdna() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: config } = useQuery<{ reviewEnabled: boolean }>({ queryKey: ["/api/config"] });
  const reviewEnabled = config?.reviewEnabled ?? false;

  const { data: items = [], isLoading } = useQuery<MdnaItem[]>({ queryKey: ["/api/mdna"] });

  const generate = useMutation<GenerateResponse, Error, string>({
    mutationFn: async (accession) => {
      const res = await apiRequest("POST", `/api/filings/${encodeURIComponent(accession)}/mdna`, {});
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "MD&A analysis failed");
      }
      return res.json();
    },
    onSuccess: (_data, accession) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mdna"] });
      setExpanded((s) => new Set(s).add(accession));
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mdna"] });
      toast({ title: "Couldn't analyze MD&A", description: err.message, variant: "destructive" });
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.ticker.toLowerCase().includes(q) ||
        it.form.toLowerCase().includes(q) ||
        (it.date || "").includes(q),
    );
  }, [items, search]);

  const toggle = (accession: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(accession) ? next.delete(accession) : next.add(accession);
      return next;
    });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold mb-1 flex items-center gap-2" data-testid="text-page-title">
          <LineChart className="w-5 h-5 text-primary" />
          MD&amp;A analysis
        </h1>
        <p className="text-sm text-muted-foreground">
          Operating story from Management&apos;s Discussion &amp; Analysis of each 10-K/10-Q — revenue
          drivers (price, volume, FX, mix), margin variance, segment results, and guidance. Separate
          from the editorial Findings.
        </p>
      </div>

      {!reviewEnabled && (
        <Card className="p-3 mb-4 flex items-center gap-2 border-amber-600/30">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Claude is off. Set <code className="text-foreground">ANTHROPIC_API_KEY</code> in the
            environment to generate MD&amp;A digests.
          </p>
        </Card>
      )}

      <Input
        placeholder="Filter by ticker, form, or date…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 max-w-xs"
        data-testid="input-mdna-filter"
      />

      {isLoading && <p className="text-sm text-muted-foreground">Loading filings…</p>}
      {!isLoading && filtered.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No rendered 10-K or 10-Q filings yet. Fetch some on the Fetch &amp; Review tab.
        </Card>
      )}

      <div className="space-y-3">
        {filtered.map((it) => {
          const isOpen = expanded.has(it.accession);
          const isAnalyzing =
            (generate.isPending && generate.variables === it.accession) ||
            it.mdnaStatus === "analyzing";
          const done = it.mdnaStatus === "done" && it.digest;
          return (
            <Card key={it.accession} className="p-0 overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(it.accession)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                data-testid={`mdna-row-${it.accession}`}
              >
                {isOpen ? (
                  <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                )}
                <span className="font-mono font-semibold">{it.ticker}</span>
                <span className="text-sm text-muted-foreground">{it.form}</span>
                {it.date && <span className="text-sm text-muted-foreground">· {it.date}</span>}
                <span className="flex-1" />
                {done && <Badge variant="secondary" className="text-[10px]">Analyzed</Badge>}
                {it.mdnaStatus === "error" && (
                  <Badge variant="destructive" className="text-[10px]">Error</Badge>
                )}
              </button>

              {isOpen && (
                <div className="px-4 pb-4 pt-1 border-t">
                  <div className="flex items-center justify-between py-2">
                    <div className="text-xs text-muted-foreground">
                      {it.digest?.period && <span className="mr-2">Period: {it.digest.period}</span>}
                      {it.costUsd != null && <span>· cost ${it.costUsd.toFixed(3)}</span>}
                    </div>
                    <Button
                      size="sm"
                      variant={done ? "outline" : "default"}
                      disabled={!reviewEnabled || isAnalyzing}
                      onClick={() => generate.mutate(it.accession)}
                      data-testid={`button-analyze-${it.accession}`}
                    >
                      {isAnalyzing ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                          Analyzing…
                        </>
                      ) : done ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                          Re-analyze
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                          Analyze MD&amp;A
                        </>
                      )}
                    </Button>
                  </div>

                  {isAnalyzing && (
                    <p className="text-sm text-muted-foreground py-2">
                      Reading the MD&amp;A section… this takes ~20–60s.
                    </p>
                  )}
                  {!isAnalyzing && it.mdnaStatus === "error" && (
                    <p className="text-sm text-destructive py-2">{it.error || "Analysis failed."}</p>
                  )}
                  {!isAnalyzing && done && it.digest && <DigestView digest={it.digest} />}
                  {!isAnalyzing && !done && it.mdnaStatus !== "error" && (
                    <p className="text-sm text-muted-foreground py-2">
                      Not analyzed yet — generate the digest to see the operating breakdown.
                    </p>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
