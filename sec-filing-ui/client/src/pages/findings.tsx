import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { API_BASE, apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Sparkles,
  ExternalLink,
  ShieldAlert,
  Search,
  Star,
  CheckCircle2,
  Ban,
  Download,
  Loader2,
  AlertCircle,
  Layers,
  X,
} from "lucide-react";
import type { Filing, FindingAction } from "@shared/schema";
import { CATEGORY_LABELS, parseFindings, interestColor, estimateReviewCost, formatCostRange, type ReviewFinding } from "@/lib/findings";

type Row = {
  filing: Filing;
  finding: ReviewFinding;
  index: number;
  key: string;
  status?: string;
};

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

function downloadCsv(rows: Row[]) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Ticker", "Form", "Filed", "Category", "Interest", "Status", "Headline", "Detail", "Why", "Accession"];
  const lines = [header.map(esc).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.filing.ticker,
        r.filing.filingType,
        r.filing.filingDate || "",
        CATEGORY_LABELS[r.finding.category] || r.finding.category,
        r.filing.reviewMateriality || "",
        r.status || "new",
        r.finding.headline,
        r.finding.detail,
        r.finding.why,
        r.filing.accessionNumber,
      ]
        .map(esc)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "findings.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const interestRank = (l?: string | null) => (l === "high" ? 3 : l === "medium" ? 2 : l === "low" ? 1 : 0);

export default function Findings() {
  const { data: filings = [] } = useQuery<Filing[]>({
    queryKey: ["/api/filings"],
    refetchInterval: (query) => {
      const rows = query.state.data as Filing[] | undefined;
      const reviewing = rows?.some(
        (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
      );
      return reviewing ? 4000 : false;
    },
  });

  const reviewing = filings.some(
    (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
  );

  const { data: actions = [] } = useQuery<FindingAction[]>({
    queryKey: ["/api/finding-actions"],
  });

  const { data: config } = useQuery<{ reviewEnabled: boolean }>({
    queryKey: ["/api/config"],
  });
  const reviewEnabled = config?.reviewEnabled ?? false;

  // Actual Claude spend so far; poll while reviews are running so it ticks up.
  const { data: usage } = useQuery<{ reviewedCount: number; costUsd: number }>({
    queryKey: ["/api/review/usage"],
    refetchInterval: reviewing ? 5000 : false,
  });

  const { toast } = useToast();

  const actionMutation = useMutation({
    mutationFn: async (vars: { accessionNumber: string; findingIndex: number; status: string }) => {
      const res = await apiRequest("POST", "/api/finding-actions", vars);
      if (!res.ok) throw new Error("Failed to update finding");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finding-actions"] }),
  });

  // Review saved-but-unreviewed PDFs straight from the Findings page
  const reviewMutation = useMutation<{ queued: number }>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/filings/review");
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Review request failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/filings"] });
      toast({
        title:
          data.queued > 0
            ? `Queued ${data.queued} saved filing${data.queued !== 1 ? "s" : ""} for review`
            : "All saved filings are already reviewed",
      });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const [activeCats, setActiveCats] = useState<Set<string>>(new Set());
  const [interest, setInterest] = useState<string>("all");
  const [triage, setTriage] = useState<string>("active");
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState<string>("date");
  const [groupByTicker, setGroupByTicker] = useState(false);
  const [confirmReview, setConfirmReview] = useState(false);
  const [showHowTo, setShowHowTo] = useState(() => {
    try {
      return localStorage.getItem("howItWorksDismissed") !== "1";
    } catch {
      return true;
    }
  });
  const dismissHowTo = () => {
    try {
      localStorage.setItem("howItWorksDismissed", "1");
    } catch {
      // ignore (private mode, etc.)
    }
    setShowHowTo(false);
  };

  // Saved PDFs that haven't been (successfully) reviewed yet
  const reviewableFilings = filings.filter(
    (f) =>
      f.status === "complete" &&
      !["done", "pending", "reviewing"].includes(f.reviewStatus || ""),
  );
  const reviewableCount = reviewableFilings.length;
  const reviewCostRange = formatCostRange(
    estimateReviewCost(reviewableFilings.map((f) => f.filingType)),
  );

  const handleReviewSaved = () => {
    if (reviewableCount > 25) {
      setConfirmReview(true);
      return;
    }
    reviewMutation.mutate();
  };

  const statusMap = new Map<string, string>();
  for (const a of actions) statusMap.set(`${a.accessionNumber}#${a.findingIndex}`, a.status);

  const allRows: Row[] = filings
    .filter((f) => f.reviewStatus === "done")
    .flatMap((f) =>
      parseFindings(f).map((finding, index) => {
        const key = `${f.accessionNumber}#${index}`;
        return { filing: f, finding, index, key, status: statusMap.get(key) };
      }),
    );

  const term = q.trim().toLowerCase();
  const filtered = allRows.filter((r) => {
    if (activeCats.size > 0 && !activeCats.has(r.finding.category)) return false;
    if (interest !== "all" && r.filing.reviewMateriality !== interest) return false;
    if (triage === "active" && r.status === "dismissed") return false;
    if (triage === "untriaged" && r.status) return false;
    if (triage === "starred" && r.status !== "starred") return false;
    if (triage === "posted" && r.status !== "posted") return false;
    if (triage === "dismissed" && r.status !== "dismissed") return false;
    if (term) {
      const hay = `${r.finding.headline} ${r.finding.detail} ${r.finding.why} ${r.filing.ticker}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });

  const byDateDesc = (a: Row, b: Row) => (b.filing.filingDate || "").localeCompare(a.filing.filingDate || "");
  const rows = [...filtered].sort((a, b) => {
    if (sortBy === "ticker")
      return a.filing.ticker.localeCompare(b.filing.ticker) || byDateDesc(a, b);
    if (sortBy === "interest")
      return interestRank(b.filing.reviewMateriality) - interestRank(a.filing.reviewMateriality) || byDateDesc(a, b);
    if (sortBy === "oldest") return (a.filing.filingDate || "").localeCompare(b.filing.filingDate || "");
    return byDateDesc(a, b);
  });

  // Group rows by ticker, ordered by finding count (most first)
  const tickerGroups: Array<[string, Row[]]> = (() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const arr = m.get(r.filing.ticker);
      if (arr) arr.push(r);
      else m.set(r.filing.ticker, [r]);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  })();

  const toggleCat = (c: string) =>
    setActiveCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const setStatus = (r: Row, target: string) => {
    actionMutation.mutate({
      accessionNumber: r.filing.accessionNumber,
      findingIndex: r.index,
      status: r.status === target ? "new" : target,
    });
  };

  const renderRow = (r: Row) => {
    const { filing, finding } = r;
    return (
      <Card
        key={r.key}
        className={`p-4 ${r.status === "dismissed" ? "opacity-60" : ""}`}
        data-testid="finding-row"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className={`w-4 h-4 mt-0.5 shrink-0 ${interestColor(filing.reviewMateriality)}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                {CATEGORY_LABELS[finding.category] || finding.category}
              </Badge>
              {r.status === "starred" && (
                <Badge className="text-[10px] bg-amber-600/20 text-amber-400 border-amber-600/30">Starred</Badge>
              )}
              {r.status === "posted" && (
                <Badge className="text-[10px] bg-green-600/20 text-green-400 border-green-600/30">Posted</Badge>
              )}
              {r.status === "dismissed" && (
                <Badge variant="secondary" className="text-[10px] text-muted-foreground">Dismissed</Badge>
              )}
              <span className="text-sm font-semibold">{finding.headline}</span>
            </div>
            <p className="text-sm text-muted-foreground">{finding.detail}</p>
            {finding.why && <p className="text-xs text-muted-foreground/80 italic mt-0.5">{finding.why}</p>}
            <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
              <span className="font-mono font-medium text-foreground">{filing.ticker}</span>
              <Badge variant="outline" className="text-[10px]">{filing.filingType}</Badge>
              {filing.filingDate && <span>{filing.filingDate}</span>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 ${r.status === "starred" ? "text-amber-400" : "text-muted-foreground"}`}
                    onClick={() => setStatus(r, "starred")}
                    data-testid={`action-star-${r.key}`}
                  >
                    <Star className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{r.status === "starred" ? "Unstar" : "Star (shortlist)"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 ${r.status === "posted" ? "text-green-400" : "text-muted-foreground"}`}
                    onClick={() => setStatus(r, "posted")}
                    data-testid={`action-posted-${r.key}`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{r.status === "posted" ? "Unmark posted" : "Mark as posted"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 ${r.status === "dismissed" ? "text-foreground" : "text-muted-foreground"}`}
                    onClick={() => setStatus(r, "dismissed")}
                    data-testid={`action-dismiss-${r.key}`}
                  >
                    <Ban className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{r.status === "dismissed" ? "Un-dismiss" : "Dismiss (hide)"}</TooltipContent>
              </Tooltip>
            </div>
            {filing.pdfPath && (
              <a
                href={`${API_BASE}/api/filings/${encodeURIComponent(filing.accessionNumber)}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button size="sm" variant="secondary" data-testid={`source-${filing.accessionNumber}`}>
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  Source
                </Button>
              </a>
            )}
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
            Findings
          </h1>
          <p className="text-sm text-muted-foreground">
            Findings are generated automatically:{" "}
            <Link href="/fetch" className="text-primary hover:underline">
              fetch filings
            </Link>{" "}
            → Claude reviews each one → post-worthy details show up here. Triage them, then open the source.
          </p>
          {usage && usage.reviewedCount > 0 && (
            <p className="text-xs text-muted-foreground mt-1" data-testid="text-review-spend">
              Claude review spend so far:{" "}
              <span className="text-foreground font-medium">${usage.costUsd.toFixed(2)}</span> across{" "}
              {usage.reviewedCount} filing{usage.reviewedCount !== 1 ? "s" : ""}
              {reviewing && <span className="text-amber-400"> · updating…</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {reviewEnabled && (reviewableCount > 0 || reviewing) && (
            <Button
              size="sm"
              onClick={handleReviewSaved}
              disabled={reviewMutation.isPending || reviewing}
              data-testid="button-review-saved"
            >
              {reviewMutation.isPending || reviewing ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              )}
              {reviewing ? "Reviewing…" : `Review ${reviewableCount} saved`}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => downloadCsv(rows)}
            disabled={rows.length === 0}
            data-testid="button-export-findings"
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* First-run "how it works" card */}
      {showHowTo && (
        <Card className="p-4 mb-4 relative" data-testid="card-how-it-works">
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 h-6 w-6 text-muted-foreground"
            onClick={dismissHowTo}
            aria-label="Dismiss"
            data-testid="button-dismiss-howto"
          >
            <X className="w-4 h-4" />
          </Button>
          <p className="text-sm font-semibold mb-2">How this works</p>
          <ol className="space-y-1.5 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground font-medium">1.</span> Watchlists track companies — an{" "}
              <span className="text-foreground">S&amp;P 500</span> list is already set up for you.
            </li>
            <li>
              <span className="text-foreground font-medium">2.</span> On{" "}
              <Link href="/fetch" className="text-primary hover:underline">
                Fetch &amp; Review
              </Link>
              , pull filings — Claude automatically reviews each one for post-worthy details.
            </li>
            <li>
              <span className="text-foreground font-medium">3.</span> Findings appear here. Star, mark posted,
              or dismiss to triage; export to CSV for drafting.
            </li>
            <li>
              <span className="text-foreground font-medium">4.</span> Use{" "}
              <Link href="/compare" className="text-primary hover:underline">
                Compare
              </Link>{" "}
              to diff a section (e.g. Risk Factors) between two filings.
            </li>
          </ol>
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={dismissHowTo} data-testid="button-howto-gotit">
              Got it
            </Button>
          </div>
        </Card>
      )}

      {/* Review availability notice */}
      {config && !reviewEnabled && (
        <Card className="p-3 mb-4 flex items-center gap-2 border-amber-600/30" data-testid="card-review-disabled">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Claude review is off. Set <code className="text-foreground">ANTHROPIC_API_KEY</code> in the
            environment to review saved filings for footnoted-worthy findings.
          </p>
        </Card>
      )}
      {reviewEnabled && reviewableCount > 0 && !reviewing && allRows.length === 0 && (
        <Card className="p-3 mb-4 flex items-center gap-2" data-testid="card-review-available">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          <p className="text-xs text-muted-foreground">
            {reviewableCount} saved filing{reviewableCount !== 1 ? "s" : ""} in your library{" "}
            {reviewableCount !== 1 ? "haven't" : "hasn't"} been reviewed yet. Click{" "}
            <span className="font-medium text-foreground">Review {reviewableCount} saved</span> above to scan
            them.
          </p>
        </Card>
      )}

      {/* Filters */}
      <Card className="p-4 mb-6 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {CATEGORY_KEYS.map((c) => (
            <button
              key={c}
              onClick={() => toggleCat(c)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                activeCats.has(c)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "hover:bg-accent/50"
              }`}
              data-testid={`filter-cat-${c}`}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search findings or ticker…"
              className="pl-8"
              data-testid="input-findings-search"
            />
          </div>
          <Select value={triage} onValueChange={setTriage}>
            <SelectTrigger className="w-[150px]" data-testid="select-triage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="untriaged">Untriaged</SelectItem>
              <SelectItem value="starred">Starred</SelectItem>
              <SelectItem value="posted">Posted</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Select value={interest} onValueChange={setInterest}>
            <SelectTrigger className="w-36" data-testid="select-interest">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All interest</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-36" data-testid="select-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="ticker">Ticker A–Z</SelectItem>
              <SelectItem value="interest">Interest</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant={groupByTicker ? "default" : "outline"}
            size="sm"
            onClick={() => setGroupByTicker((v) => !v)}
            data-testid="button-group-ticker"
          >
            <Layers className="w-3.5 h-3.5 mr-1.5" />
            Group by ticker
          </Button>
        </div>
      </Card>

      <div className="mb-3 text-sm text-muted-foreground">
        {rows.length} finding{rows.length !== 1 ? "s" : ""}
        {allRows.length !== rows.length ? ` of ${allRows.length}` : ""}
        {groupByTicker ? ` across ${tickerGroups.length} ticker${tickerGroups.length !== 1 ? "s" : ""}` : ""}
        {reviewing && <span className="ml-2 text-amber-400">· reviewing in progress…</span>}
      </div>

      {rows.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-primary" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {allRows.length > 0
              ? "No findings match your filters."
              : reviewEnabled && reviewableCount > 0
                ? `${reviewableCount} saved filing${reviewableCount !== 1 ? "s are" : " is"} ready to review — click "Review ${reviewableCount} saved" above.`
                : !reviewEnabled
                  ? "No findings yet. Set ANTHROPIC_API_KEY to enable Claude review, then review your saved filings."
                  : "No findings yet. Fetch filings on the Fetch Filings page, then review them."}
          </p>
        </Card>
      ) : groupByTicker ? (
        <div className="space-y-6">
          {tickerGroups.map(([tk, rs]) => (
            <div key={tk} className="space-y-2">
              <div className="flex items-center gap-2 border-b pb-1.5">
                <span className="font-mono font-semibold text-sm">{tk}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {rs.length} finding{rs.length !== 1 ? "s" : ""}
                </Badge>
              </div>
              {rs.map(renderRow)}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">{rows.map(renderRow)}</div>
      )}

      <AlertDialog open={confirmReview} onOpenChange={setConfirmReview}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review the saved library with Claude?</AlertDialogTitle>
            <AlertDialogDescription>
              This will run a Claude review on ~{reviewableCount} saved filing
              {reviewableCount !== 1 ? "s" : ""}. Estimated Claude cost:{" "}
              <span className="text-foreground font-medium">{reviewCostRange}</span> (Opus 4.7; rough,
              varies with filing length). It can also take a while.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReview(false);
                reviewMutation.mutate();
              }}
              data-testid="button-confirm-review-saved"
            >
              Review
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
