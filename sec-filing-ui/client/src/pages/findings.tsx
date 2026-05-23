import { useState } from "react";
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
import { Sparkles, ExternalLink, ShieldAlert, Search, Star, CheckCircle2, Ban, Download } from "lucide-react";
import type { Filing, FindingAction } from "@shared/schema";
import { CATEGORY_LABELS, parseFindings, interestColor, type ReviewFinding } from "@/lib/findings";

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

  const { data: actions = [] } = useQuery<FindingAction[]>({
    queryKey: ["/api/finding-actions"],
  });

  const actionMutation = useMutation({
    mutationFn: async (vars: { accessionNumber: string; findingIndex: number; status: string }) => {
      const res = await apiRequest("POST", "/api/finding-actions", vars);
      if (!res.ok) throw new Error("Failed to update finding");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/finding-actions"] }),
  });

  const [activeCats, setActiveCats] = useState<Set<string>>(new Set());
  const [interest, setInterest] = useState<string>("all");
  const [triage, setTriage] = useState<string>("active");
  const [q, setQ] = useState("");

  const statusMap = new Map<string, string>();
  for (const a of actions) statusMap.set(`${a.accessionNumber}#${a.findingIndex}`, a.status);

  const allRows: Row[] = filings
    .filter((f) => f.reviewStatus === "done")
    .flatMap((f) =>
      parseFindings(f).map((finding, index) => {
        const key = `${f.accessionNumber}#${index}`;
        return { filing: f, finding, index, key, status: statusMap.get(key) };
      }),
    )
    .sort((a, b) => (b.filing.filingDate || "").localeCompare(a.filing.filingDate || ""));

  const term = q.trim().toLowerCase();
  const rows = allRows.filter((r) => {
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

  const reviewing = filings.some(
    (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
  );

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

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
            Findings
          </h1>
          <p className="text-sm text-muted-foreground">
            Post-worthy details Claude surfaced across your reviewed filings — triage, then open the source.
          </p>
        </div>
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
            <SelectTrigger className="w-40" data-testid="select-triage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active (not dismissed)</SelectItem>
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
        </div>
      </Card>

      <div className="mb-3 text-sm text-muted-foreground">
        {rows.length} finding{rows.length !== 1 ? "s" : ""}
        {allRows.length !== rows.length ? ` of ${allRows.length}` : ""}
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
            {allRows.length === 0
              ? "No findings yet. Fetch filings and run a review on the Fetch Filings page."
              : "No findings match your filters."}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
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
                        <Badge className="text-[10px] bg-amber-600/20 text-amber-400 border-amber-600/30">
                          Starred
                        </Badge>
                      )}
                      {r.status === "posted" && (
                        <Badge className="text-[10px] bg-green-600/20 text-green-400 border-green-600/30">
                          Posted
                        </Badge>
                      )}
                      {r.status === "dismissed" && (
                        <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                          Dismissed
                        </Badge>
                      )}
                      <span className="text-sm font-semibold">{finding.headline}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{finding.detail}</p>
                    {finding.why && (
                      <p className="text-xs text-muted-foreground/80 italic mt-0.5">{finding.why}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                      <span className="font-mono font-medium text-foreground">{filing.ticker}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {filing.filingType}
                      </Badge>
                      {filing.filingDate && <span>{filing.filingDate}</span>}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-7 w-7 ${r.status === "starred" ? "text-amber-400" : "text-muted-foreground"}`}
                        title="Star"
                        onClick={() => setStatus(r, "starred")}
                        data-testid={`action-star-${r.key}`}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-7 w-7 ${r.status === "posted" ? "text-green-400" : "text-muted-foreground"}`}
                        title="Mark posted"
                        onClick={() => setStatus(r, "posted")}
                        data-testid={`action-posted-${r.key}`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-7 w-7 ${r.status === "dismissed" ? "text-foreground" : "text-muted-foreground"}`}
                        title="Dismiss"
                        onClick={() => setStatus(r, "dismissed")}
                        data-testid={`action-dismiss-${r.key}`}
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </Button>
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
          })}
        </div>
      )}
    </div>
  );
}
