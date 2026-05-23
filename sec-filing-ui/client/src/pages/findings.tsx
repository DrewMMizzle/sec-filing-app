import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/queryClient";
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
import { Sparkles, ExternalLink, ShieldAlert, Search } from "lucide-react";
import type { Filing } from "@shared/schema";
import { CATEGORY_LABELS, parseFindings, interestColor, type ReviewFinding } from "@/lib/findings";

type Row = { filing: Filing; finding: ReviewFinding };

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

export default function Findings() {
  const { data: filings = [] } = useQuery<Filing[]>({
    queryKey: ["/api/filings"],
    // Keep the feed live while reviews are still running.
    refetchInterval: (query) => {
      const rows = query.state.data as Filing[] | undefined;
      const reviewing = rows?.some(
        (f) => f.reviewStatus === "pending" || f.reviewStatus === "reviewing",
      );
      return reviewing ? 4000 : false;
    },
  });

  const [activeCats, setActiveCats] = useState<Set<string>>(new Set());
  const [interest, setInterest] = useState<string>("all");
  const [q, setQ] = useState("");

  const allRows: Row[] = filings
    .filter((f) => f.reviewStatus === "done")
    .flatMap((f) => parseFindings(f).map((finding) => ({ filing: f, finding })))
    .sort((a, b) => (b.filing.filingDate || "").localeCompare(a.filing.filingDate || ""));

  const term = q.trim().toLowerCase();
  const rows = allRows.filter(({ filing, finding }) => {
    if (activeCats.size > 0 && !activeCats.has(finding.category)) return false;
    if (interest !== "all" && filing.reviewMateriality !== interest) return false;
    if (term) {
      const hay = `${finding.headline} ${finding.detail} ${finding.why} ${filing.ticker}`.toLowerCase();
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

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
          Findings
        </h1>
        <p className="text-sm text-muted-foreground">
          Post-worthy details Claude surfaced across your reviewed filings — scan, filter, and open the
          source filing.
        </p>
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
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search findings or ticker…"
              className="pl-8"
              data-testid="input-findings-search"
            />
          </div>
          <Select value={interest} onValueChange={setInterest}>
            <SelectTrigger className="w-40" data-testid="select-interest">
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
          {rows.map(({ filing, finding }, i) => (
            <Card key={`${filing.accessionNumber}-${i}`} className="p-4" data-testid="finding-row">
              <div className="flex items-start gap-3">
                <ShieldAlert className={`w-4 h-4 mt-0.5 shrink-0 ${interestColor(filing.reviewMateriality)}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                      {CATEGORY_LABELS[finding.category] || finding.category}
                    </Badge>
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
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
