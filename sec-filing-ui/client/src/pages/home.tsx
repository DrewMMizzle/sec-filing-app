import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FileText, List, Plus, ArrowRight, Download } from "lucide-react";

type WatchlistSummary = {
  id: number;
  name: string;
  tickerCount: number;
};

export default function Home() {
  const { toast } = useToast();
  const { data: watchlists = [] } = useQuery<WatchlistSummary[]>({
    queryKey: ["/api/watchlists"],
  });

  const handleExport = async () => {
    try {
      const res = await apiRequest("GET", "/api/export-watchlist");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "watchlist.json";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: `Exported ${data.length} ticker(s) to watchlist.json` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
          SEC Filing Watchlists
        </h1>
        <p className="text-sm text-muted-foreground">
          Create and manage ticker lists to monitor SEC EDGAR filings. Add tickers to watchlists, 
          then poll for new filings and render them as PDFs.
        </p>
      </div>

      {watchlists.length > 0 && (
        <div className="mb-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExport}
            data-testid="button-export-watchlist"
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Export watchlist.json
          </Button>
        </div>
      )}

      {watchlists.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <FileText className="w-6 h-6 text-primary" />
            </div>
          </div>
          <p className="text-sm font-medium mb-1">No watchlists yet</p>
          <p className="text-xs text-muted-foreground mb-4">
            Create your first watchlist using the + button in the sidebar.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {watchlists.map((wl) => (
            <Link key={wl.id} href={`/watchlist/${wl.id}`}>
              <Card
                className="p-4 flex items-center gap-3 cursor-pointer transition-colors hover:bg-accent/50"
                data-testid={`card-watchlist-${wl.id}`}
              >
                <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <List className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{wl.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {wl.tickerCount} ticker{wl.tickerCount !== 1 ? "s" : ""}
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
