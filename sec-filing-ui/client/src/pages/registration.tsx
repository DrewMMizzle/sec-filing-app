import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
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
  Rocket,
  Search,
  Loader2,
  AlertCircle,
  Sparkles,
  GitCompareArrows,
  Plus,
  Minus,
  Pencil,
} from "lucide-react";

// ─── Types mirroring the /api/registration/* endpoints ───────────────
type EdgarCompany = { cik: string; name: string; ticker?: string };
type RegistrationFiling = {
  accessionNumber: string;
  form: "S-1" | "S-1/A" | string;
  filingDate: string;
  primaryDocUrl: string;
  // null when the filing has no DB row yet — i.e. it hasn't been rendered.
  // "complete" means the PDF is on disk and the row is reviewable.
  dbStatus: "pending" | "rendering" | "complete" | "error" | null;
  reviewStatus: "pending" | "reviewing" | "done" | "error" | null;
};
type RenderResponse = {
  ok: boolean;
  label: string;
  cik: string;
  companyName: string;
  rendered: number;
};
type RegistrationSectionKey =
  | "all"
  | "risk_factors"
  | "prospectus_summary"
  | "business"
  | "mdna"
  | "use_of_proceeds"
  | "dilution"
  | "capitalization"
  | "executive_compensation"
  | "underwriting";
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
  section: RegistrationSectionKey;
  sectionLabel: string;
  earlier: { accession: string; form: string; date: string; found: boolean; sourceUrl: string };
  later: { accession: string; form: string; date: string; found: boolean; sourceUrl: string };
  diff: DiffSegment[] | null;
  changelog: Changelog | null;
  costUsd: number;
  note?: string;
};

const REGISTRATION_COMPARE_SECTIONS: Array<{ key: RegistrationSectionKey; label: string }> = [
  { key: "risk_factors", label: "Risk Factors" },
  { key: "prospectus_summary", label: "Prospectus Summary" },
  { key: "business", label: "Business" },
  { key: "mdna", label: "MD&A" },
  { key: "use_of_proceeds", label: "Use of Proceeds" },
  { key: "dilution", label: "Dilution" },
  { key: "capitalization", label: "Capitalization" },
  { key: "executive_compensation", label: "Executive Compensation" },
  { key: "underwriting", label: "Underwriting" },
  { key: "all", label: "All material changes" },
];

// Reviewing one S-1 / S-1/A is genuinely expensive (large input, $5/1M
// input tokens for Opus 4.7) — show this estimate before the user opts
// in per filing.
const REVIEW_COST_ESTIMATE = "$1.50 – $4.00 (Opus 4.7; rough)";

export default function Registration() {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<EdgarCompany | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewConfirm, setReviewConfirm] = useState<string | null>(null);
  const [compareSection, setCompareSection] = useState<RegistrationSectionKey>("risk_factors");
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);

  // ─── Search ────────────────────────────────────────────────────────
  const search = useMutation<EdgarCompany[], Error, string>({
    mutationFn: async (q) => {
      const res = await apiRequest("GET", `/api/registration/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error((await res.json()).error || "Search failed");
      return res.json();
    },
    onSuccess: (data) => {
      if (data.length === 0) toast({ title: "No matches at SEC for that query." });
    },
    onError: (err) => toast({ title: "Search failed", description: err.message, variant: "destructive" }),
  });

  // ─── List the picked company's S-1 / S-1/A history ────────────────
  const filingsQuery = useQuery<RegistrationFiling[]>({
    queryKey: ["/api/registration/filings", picked?.cik],
    queryFn: async () => {
      if (!picked) return [];
      const res = await apiRequest("GET", `/api/registration/filings?cik=${encodeURIComponent(picked.cik)}`);
      if (!res.ok) throw new Error((await res.json()).error || "Failed to load filings");
      return res.json();
    },
    enabled: !!picked,
  });

  // ─── Render ────────────────────────────────────────────────────────
  const render = useMutation<RenderResponse, Error, { accessions: string[] }>({
    mutationFn: async ({ accessions }) => {
      if (!picked) throw new Error("No company picked");
      const res = await apiRequest("POST", "/api/registration/render", {
        cik: picked.cik,
        companyName: picked.name,
        ticker: picked.ticker,
        accessions,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Render failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/filings?slim=true"] });
      // Refresh the registration listing so the just-rendered filing's
      // dbStatus flips to "complete" and the Review button appears.
      if (picked) {
        queryClient.invalidateQueries({ queryKey: ["/api/registration/filings", picked.cik] });
      }
      toast({
        title: data.rendered > 0 ? "Render complete" : "Pipeline ran but nothing rendered",
        description: `${data.companyName} → ${data.rendered} S-1 / S-1/A PDF(s)`,
      });
      setSelected(new Set());
    },
    onError: (err) =>
      toast({ title: "Render failed", description: err.message, variant: "destructive" }),
  });

  // ─── Compare ───────────────────────────────────────────────────────
  // Compare selected S-1 / S-1/A versions directly from SEC primary HTML.
  // This does not require the filings to render to PDF first.
  const compare = useMutation<
    CompareResult,
    Error,
    { accessions: string[]; section: RegistrationSectionKey }
  >({
    mutationFn: async ({ accessions, section }) => {
      if (!picked) throw new Error("No company picked");
      if (accessions.length !== 2) throw new Error("Pick exactly two filings to compare");
      const res = await apiRequest("POST", "/api/registration/compare", {
        cik: picked.cik,
        accessionA: accessions[0],
        accessionB: accessions[1],
        section,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Comparison failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setCompareResult(data);
      toast({
        title: "Comparison complete",
        description: `${data.earlier.form} ${data.earlier.date} to ${data.later.form} ${data.later.date}`,
      });
    },
    onError: (err) =>
      toast({ title: "Comparison failed", description: err.message, variant: "destructive" }),
  });

  // ─── Review (opt-in, per filing) ───────────────────────────────────
  const review = useMutation<{ ok: boolean }, Error, string>({
    mutationFn: async (accession) => {
      const res = await apiRequest("POST", `/api/filings/${encodeURIComponent(accession)}/review`, {});
      if (!res.ok) throw new Error((await res.json()).error || "Review failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Review queued", description: "Findings will appear in the Findings tab when done." });
    },
    onError: (err) => toast({ title: "Review failed", description: err.message, variant: "destructive" }),
  });

  // ─── Handlers ──────────────────────────────────────────────────────
  const submitSearch = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setPicked(null);
    setSelected(new Set());
    setCompareResult(null);
    search.mutate(trimmed);
  };

  const toggleAccession = (acc: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(acc) ? next.delete(acc) : next.add(acc);
      return next;
    });

  const renderLatest = () => {
    const f = filingsQuery.data?.[0];
    if (!f) return;
    render.mutate({ accessions: [f.accessionNumber] });
  };

  const renderSelected = () => {
    if (selected.size === 0) return;
    render.mutate({ accessions: Array.from(selected) });
  };

  const compareSelected = () => {
    if (selected.size !== 2) {
      toast({
        title: "Pick exactly two filings",
        description: "Select the original S-1 and one S-1/A amendment to compare.",
        variant: "destructive",
      });
      return;
    }
    setCompareResult(null);
    compare.mutate({ accessions: Array.from(selected), section: compareSection });
  };

  const filings = filingsQuery.data ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10 shrink-0">
          <Rocket className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
            Registration / IPO filings
          </h1>
          <p className="text-sm text-muted-foreground">
            Pull S-1 and S-1/A filings from SEC EDGAR for any company — including
            pre-IPO filers that aren&apos;t in the tickered universe yet. Kept separate
            from the normal Fetch flow because these documents are very large
            and slow to render.
          </p>
        </div>
      </div>

      <Card className="p-3 mb-4 flex items-start gap-2 border-amber-600/30">
        <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground font-medium">Heads up:</span> S-1 / S-1/A filings can
          be 500+ pages. Render runs single-filing, on-demand, and does not auto-review. Use the
          per-row <span className="text-foreground">Review</span> button after render if you want
          Claude findings (~{REVIEW_COST_ESTIMATE} per filing).
        </p>
      </Card>

      {/* ─── Lookup ───────────────────────────────────────────────── */}
      <div className="mb-4">
        <label className="text-sm font-medium mb-1.5 block">
          Company name, ticker, or CIK
        </label>
        <div className="flex gap-2">
          <Input
            placeholder="e.g. SpaceX, AAPL, 1318605"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitSearch();
              }
            }}
            data-testid="input-registration-query"
          />
          <Button
            onClick={submitSearch}
            disabled={!query.trim() || search.isPending}
            data-testid="button-registration-search"
          >
            {search.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {/* ─── Search results ───────────────────────────────────────── */}
      {search.data && search.data.length > 0 && !picked && (
        <Card className="mb-4 divide-y">
          {search.data.map((c) => (
            <button
              key={c.cik}
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-muted/40 transition-colors"
              onClick={() => {
                setPicked(c);
                setSelected(new Set());
                setCompareResult(null);
              }}
              data-testid={`button-registration-pick-${c.cik}`}
            >
              <div className="text-sm font-medium truncate">{c.name}</div>
              <div className="text-xs text-muted-foreground font-mono">
                CIK {c.cik}
                {c.ticker ? ` · ${c.ticker}` : " · (no ticker)"}
              </div>
            </button>
          ))}
        </Card>
      )}

      {/* ─── Picked company + filings list ────────────────────────── */}
      {picked && (
        <div>
          <Card className="p-3 mb-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{picked.name}</p>
              <p className="text-xs text-muted-foreground font-mono">
                CIK {picked.cik}
                {picked.ticker ? ` · ${picked.ticker}` : " · pre-IPO"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPicked(null);
                setSelected(new Set());
                setCompareResult(null);
              }}
              data-testid="button-registration-back"
            >
              Pick another
            </Button>
          </Card>

          {filingsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading S-1 / S-1/A history from EDGAR…</p>
          )}
          {filingsQuery.error && (
            <p className="text-sm text-destructive">
              Couldn&apos;t load filings: {(filingsQuery.error as Error).message}
            </p>
          )}
          {!filingsQuery.isLoading && !filingsQuery.error && filings.length === 0 && (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              No S-1 or S-1/A filings in this company&apos;s recent submissions.
            </Card>
          )}

          {filings.length > 0 && (
            <>
              <div className="flex flex-col gap-2 mb-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={compareSection}
                    onValueChange={(value) => setCompareSection(value as RegistrationSectionKey)}
                  >
                    <SelectTrigger className="h-9 w-[210px]" data-testid="select-registration-compare-section">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REGISTRATION_COMPARE_SECTIONS.map((section) => (
                        <SelectItem key={section.key} value={section.key}>
                          {section.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    onClick={compareSelected}
                    disabled={selected.size !== 2 || compare.isPending}
                    data-testid="button-registration-compare"
                  >
                    {compare.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Comparing...
                      </>
                    ) : (
                      <>
                        <GitCompareArrows className="w-4 h-4 mr-2" />
                        Compare selected
                      </>
                    )}
                  </Button>
                </div>
                <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={renderLatest}
                  disabled={render.isPending}
                  data-testid="button-render-latest"
                >
                  {render.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Rendering…
                    </>
                  ) : (
                    "Render latest"
                  )}
                </Button>
                <Button
                  onClick={renderSelected}
                  disabled={selected.size === 0 || render.isPending}
                  data-testid="button-render-selected"
                >
                  {render.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Rendering…
                    </>
                  ) : (
                    `Render selected (${selected.size})`
                  )}
                </Button>
              </div>
              </div>

              <Card className="divide-y">
                {filings.map((f, i) => {
                  const rendered = f.dbStatus === "complete";
                  const reviewing = f.reviewStatus === "pending" || f.reviewStatus === "reviewing";
                  const reviewed = f.reviewStatus === "done";
                  return (
                    <div
                      key={f.accessionNumber}
                      className="flex items-center gap-3 px-3 py-2 text-sm"
                      data-testid={`registration-filing-${f.accessionNumber}`}
                    >
                      <Checkbox
                        checked={selected.has(f.accessionNumber)}
                        onCheckedChange={() => toggleAccession(f.accessionNumber)}
                        data-testid={`checkbox-registration-${f.accessionNumber}`}
                      />
                      <Badge variant="secondary" className="text-[10px]">{f.form}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">{f.filingDate}</span>
                      <span className="font-mono text-xs text-muted-foreground truncate flex-1">
                        {f.accessionNumber}
                      </span>
                      {i === 0 && (
                        <Badge variant="outline" className="text-[10px]">Latest</Badge>
                      )}
                      {/* Status badges reflect the DB row, so the user can see
                          which filings are rendered and reviewable. */}
                      {f.dbStatus === "rendering" && (
                        <Badge variant="default" className="text-[10px] bg-amber-600/20 text-amber-400 border-amber-600/30">
                          Rendering
                        </Badge>
                      )}
                      {f.dbStatus === "error" && (
                        <Badge variant="destructive" className="text-[10px]">Error</Badge>
                      )}
                      {rendered && !reviewing && !reviewed && (
                        <Badge variant="outline" className="text-[10px]">Rendered</Badge>
                      )}
                      {reviewing && (
                        <Badge variant="default" className="text-[10px] bg-amber-600/20 text-amber-400 border-amber-600/30">
                          Reviewing
                        </Badge>
                      )}
                      {reviewed && (
                        <Badge variant="default" className="text-[10px]">Reviewed</Badge>
                      )}
                      {/* Review button only appears once the filing is
                          actually rendered (has a complete DB row) — calling
                          /api/filings/:accession/review on an unrendered
                          accession would just return 400. */}
                      {rendered && !reviewing && !reviewed && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setReviewConfirm(f.accessionNumber)}
                          data-testid={`button-review-${f.accessionNumber}`}
                          title="Run Claude review on this filing (cost warning will appear)"
                        >
                          <Sparkles className="w-3 h-3 mr-1" />
                          Review
                        </Button>
                      )}
                    </div>
                  );
                })}
              </Card>

              {compareResult && (
                <Card className="mt-4 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm flex-wrap border-b pb-2">
                    <GitCompareArrows className="w-4 h-4 text-primary" />
                    <span className="font-semibold">{compareResult.sectionLabel}</span>
                    <Badge variant="outline">
                      {compareResult.earlier.form} {compareResult.earlier.date}
                    </Badge>
                    <span className="text-muted-foreground">to</span>
                    <Badge variant="outline">
                      {compareResult.later.form} {compareResult.later.date}
                    </Badge>
                  </div>

                  {compareResult.note && (
                    <p className="rounded-md border border-amber-600/30 bg-amber-600/10 p-3 text-xs text-muted-foreground">
                      {compareResult.note}
                    </p>
                  )}

                  {compareResult.changelog ? (
                    <>
                      <p className="text-sm">{compareResult.changelog.summary}</p>
                      {compareResult.changelog.added.length > 0 && (
                        <ChangeGroup
                          title="Added"
                          icon={<Plus className="w-3.5 h-3.5 text-green-400" />}
                          items={compareResult.changelog.added}
                        />
                      )}
                      {compareResult.changelog.removed.length > 0 && (
                        <ChangeGroup
                          title="Removed"
                          icon={<Minus className="w-3.5 h-3.5 text-red-400" />}
                          items={compareResult.changelog.removed}
                        />
                      )}
                      {compareResult.changelog.changed.length > 0 && (
                        <ChangeGroup
                          title="Changed"
                          icon={<Pencil className="w-3.5 h-3.5 text-amber-400" />}
                          items={compareResult.changelog.changed}
                        />
                      )}
                      {compareResult.changelog.unchanged && (
                        <p className="text-xs text-muted-foreground">
                          Claude did not identify material changes in this section.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No changelog was returned for this comparison.
                    </p>
                  )}

                  {compareResult.costUsd > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Claude comparison cost: ${compareResult.costUsd.toFixed(2)}
                    </p>
                  )}
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* ─── Review cost confirmation dialog ───────────────────────── */}
      <AlertDialog
        open={reviewConfirm !== null}
        onOpenChange={(open) => { if (!open) setReviewConfirm(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run Claude review on this S-1?</AlertDialogTitle>
            <AlertDialogDescription>
              Reviewing a registration statement is expensive — input is much larger than a
              typical 10-K. Estimated Claude cost: <span className="text-foreground font-medium">{REVIEW_COST_ESTIMATE}</span>.
              The review will be charged against the team-wide review spend cap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (reviewConfirm) review.mutate(reviewConfirm);
                setReviewConfirm(null);
              }}
              data-testid="button-confirm-review"
            >
              Run review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ChangeGroup({ title, icon, items }: { title: string; icon: ReactNode; items: ChangeItem[] }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="flex items-center gap-1.5 mb-2">
        {icon}
        <span className="text-sm font-semibold">
          {title} ({items.length})
        </span>
      </div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="rounded-md border border-border/60 bg-background/50 p-2.5">
            <p className="text-sm font-medium">{item.headline}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
