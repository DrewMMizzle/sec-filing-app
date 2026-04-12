import { useState, useMemo } from "react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Database,
  Download,
  ExternalLink,
  Trash2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Check,
  X,
  Loader2,
  HardDrive,
  FileText,
  BarChart3,
  AlertCircle,
} from "lucide-react";
import type { Filing } from "@shared/schema";

type FilingStats = {
  totalCount: number;
  completeCount: number;
  errorCount: number;
  totalSizeMb: number;
  tickers: string[];
  filingTypes: string[];
};

type SortField = "ticker" | "filingType" | "filingDate" | "status" | "pdfSize";
type SortDir = "asc" | "desc";

export default function PdfLibrary() {
  const { toast } = useToast();

  // Filters
  const [tickerFilter, setTickerFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Sorting
  const [sortField, setSortField] = useState<SortField>("filingDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);

  // Data queries
  const { data: allFilings = [], isLoading: filingsLoading } = useQuery<Filing[]>({
    queryKey: ["/api/filings"],
  });

  const { data: stats } = useQuery<FilingStats>({
    queryKey: ["/api/filings/stats"],
  });

  // Derive unique tickers and types from data
  const availableTickers = useMemo(() => {
    const set = new Set(allFilings.map((f) => f.ticker));
    return Array.from(set).sort();
  }, [allFilings]);

  const availableTypes = useMemo(() => {
    const set = new Set(allFilings.map((f) => f.filingType));
    return Array.from(set).sort();
  }, [allFilings]);

  // Filter + sort logic
  const filteredFilings = useMemo(() => {
    let items = [...allFilings];

    if (tickerFilter !== "all") items = items.filter((f) => f.ticker === tickerFilter);
    if (typeFilter !== "all") items = items.filter((f) => f.filingType === typeFilter);
    if (statusFilter !== "all") items = items.filter((f) => f.status === statusFilter);
    if (dateFrom) items = items.filter((f) => f.filingDate && f.filingDate >= dateFrom);
    if (dateTo) items = items.filter((f) => f.filingDate && f.filingDate <= dateTo);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      items = items.filter(
        (f) =>
          f.ticker.toLowerCase().includes(q) ||
          f.accessionNumber.toLowerCase().includes(q) ||
          f.filingType.toLowerCase().includes(q),
      );
    }

    // Sort
    items.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "ticker":
          cmp = a.ticker.localeCompare(b.ticker);
          break;
        case "filingType":
          cmp = a.filingType.localeCompare(b.filingType);
          break;
        case "filingDate":
          cmp = (a.filingDate || "").localeCompare(b.filingDate || "");
          break;
        case "status":
          cmp = a.status.localeCompare(b.status);
          break;
        case "pdfSize":
          cmp = (a.pdfSize || 0) - (b.pdfSize || 0);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return items;
  }, [allFilings, tickerFilter, typeFilter, statusFilter, dateFrom, dateTo, searchQuery, sortField, sortDir]);

  // Selection helpers
  const allVisibleSelected =
    filteredFilings.length > 0 && filteredFilings.every((f) => selectedIds.has(f.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredFilings.map((f) => f.id)));
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Sort toggle
  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === "asc" ? (
      <ArrowUp className="w-3 h-3 ml-1" />
    ) : (
      <ArrowDown className="w-3 h-3 ml-1" />
    );
  };

  // Delete mutations
  const deleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      if (ids.length === 1) {
        await apiRequest("DELETE", `/api/filings/${ids[0]}`);
      } else {
        await apiRequest("POST", "/api/filings/batch-delete", { ids });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/filings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/filings/stats"] });
      setSelectedIds(new Set());
      toast({ title: `${pendingDeleteIds.length} filing(s) deleted` });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const confirmDelete = (ids: number[]) => {
    setPendingDeleteIds(ids);
    setDeleteDialogOpen(true);
  };

  const executeDelete = () => {
    setDeleteDialogOpen(false);
    deleteMutation.mutate(pendingDeleteIds);
  };

  // Reset filters
  const clearFilters = () => {
    setTickerFilter("all");
    setTypeFilter("all");
    setStatusFilter("all");
    setDateFrom("");
    setDateTo("");
    setSearchQuery("");
  };

  const hasActiveFilters =
    tickerFilter !== "all" ||
    typeFilter !== "all" ||
    statusFilter !== "all" ||
    dateFrom !== "" ||
    dateTo !== "" ||
    searchQuery.trim() !== "";

  const statusBadge = (status: string) => {
    switch (status) {
      case "complete":
        return (
          <Badge variant="default" className="text-xs bg-green-600/20 text-green-400 border-green-600/30">
            <Check className="w-3 h-3 mr-0.5" /> Ready
          </Badge>
        );
      case "rendering":
        return (
          <Badge variant="default" className="text-xs bg-yellow-600/20 text-yellow-400 border-yellow-600/30">
            <Loader2 className="w-3 h-3 mr-0.5 animate-spin" /> Rendering
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive" className="text-xs">
            <X className="w-3 h-3 mr-0.5" /> Error
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" className="text-xs">
            {status}
          </Badge>
        );
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold mb-1" data-testid="text-library-title">
          PDF Library
        </h1>
        <p className="text-sm text-muted-foreground">
          Browse, open, download, and manage all stored SEC filing PDFs.
        </p>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Card className="p-4" data-testid="stat-total">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center">
                <FileText className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{stats.totalCount}</p>
                <p className="text-xs text-muted-foreground">Total filings</p>
              </div>
            </div>
          </Card>
          <Card className="p-4" data-testid="stat-complete">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-green-600/10 flex items-center justify-center">
                <Check className="w-4 h-4 text-green-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{stats.completeCount}</p>
                <p className="text-xs text-muted-foreground">PDFs ready</p>
              </div>
            </div>
          </Card>
          <Card className="p-4" data-testid="stat-errors">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-red-600/10 flex items-center justify-center">
                <AlertCircle className="w-4 h-4 text-red-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{stats.errorCount}</p>
                <p className="text-xs text-muted-foreground">Errors</p>
              </div>
            </div>
          </Card>
          <Card className="p-4" data-testid="stat-storage">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-md bg-blue-600/10 flex items-center justify-center">
                <HardDrive className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{stats.totalSizeMb} MB</p>
                <p className="text-xs text-muted-foreground">Storage used</p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px] max-w-[240px]">
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Search</label>
            <Input
              placeholder="Ticker, accession, type..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9"
              data-testid="input-search"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Ticker</label>
            <Select value={tickerFilter} onValueChange={setTickerFilter}>
              <SelectTrigger className="w-32 h-9" data-testid="filter-ticker">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {availableTickers.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-28 h-9" data-testid="filter-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {availableTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-32 h-9" data-testid="filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="complete">Ready</SelectItem>
                <SelectItem value="rendering">Rendering</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">From</label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-36 h-9"
              data-testid="filter-date-from"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">To</label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-36 h-9"
              data-testid="filter-date-to"
            />
          </div>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-9 text-xs text-muted-foreground"
              data-testid="button-clear-filters"
            >
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      {/* Toolbar: selection count + batch actions */}
      <div className="flex items-center justify-between mb-3 min-h-[36px]">
        <p className="text-sm text-muted-foreground">
          {filteredFilings.length} filing{filteredFilings.length !== 1 ? "s" : ""}
          {selectedIds.size > 0 && (
            <span className="ml-2 text-foreground font-medium">
              · {selectedIds.size} selected
            </span>
          )}
        </p>
        {selectedIds.size > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => confirmDelete(Array.from(selectedIds))}
            disabled={deleteMutation.isPending}
            data-testid="button-batch-delete"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Delete {selectedIds.size} filing{selectedIds.size !== 1 ? "s" : ""}
          </Button>
        )}
      </div>

      {/* Table */}
      {filingsLoading ? (
        <Card className="p-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading filings...</p>
        </Card>
      ) : filteredFilings.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Database className="w-6 h-6 text-primary" />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {allFilings.length === 0
              ? "No filings in the library yet. Use Fetch Filings to download SEC filings."
              : "No filings match the current filters."}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleSelectAll}
                      data-testid="checkbox-select-all"
                    />
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center text-xs font-medium hover:text-foreground transition-colors"
                      onClick={() => toggleSort("ticker")}
                      data-testid="sort-ticker"
                    >
                      Ticker <SortIcon field="ticker" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center text-xs font-medium hover:text-foreground transition-colors"
                      onClick={() => toggleSort("filingType")}
                      data-testid="sort-type"
                    >
                      Type <SortIcon field="filingType" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center text-xs font-medium hover:text-foreground transition-colors"
                      onClick={() => toggleSort("filingDate")}
                      data-testid="sort-date"
                    >
                      Filed <SortIcon field="filingDate" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center text-xs font-medium hover:text-foreground transition-colors"
                      onClick={() => toggleSort("status")}
                      data-testid="sort-status"
                    >
                      Status <SortIcon field="status" />
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      className="flex items-center text-xs font-medium hover:text-foreground transition-colors"
                      onClick={() => toggleSort("pdfSize")}
                      data-testid="sort-size"
                    >
                      Size <SortIcon field="pdfSize" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFilings.map((f) => (
                  <TableRow
                    key={f.id}
                    className={selectedIds.has(f.id) ? "bg-accent/30" : ""}
                    data-testid={`row-filing-${f.id}`}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selectedIds.has(f.id)}
                        onCheckedChange={() => toggleSelect(f.id)}
                        data-testid={`checkbox-filing-${f.id}`}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="font-mono font-semibold text-sm">{f.ticker}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">{f.filingType}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm tabular-nums">{f.filingDate || "—"}</span>
                    </TableCell>
                    <TableCell>{statusBadge(f.status)}</TableCell>
                    <TableCell>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {f.pdfSize ? `${(f.pdfSize / 1024 / 1024).toFixed(1)} MB` : "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {f.status === "complete" && f.pdfPath && (
                          <>
                            <a
                              href={`${API_BASE}/api/filings/${encodeURIComponent(f.accessionNumber)}/view`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="Open in new tab"
                                data-testid={`button-open-${f.id}`}
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </Button>
                            </a>
                            <a
                              href={`${API_BASE}/api/filings/${encodeURIComponent(f.accessionNumber)}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="Download"
                                data-testid={`button-download-${f.id}`}
                              >
                                <Download className="w-3.5 h-3.5" />
                              </Button>
                            </a>
                          </>
                        )}
                        {f.status === "error" && f.errorMessage && (
                          <span
                            className="text-xs text-destructive max-w-32 truncate"
                            title={f.errorMessage}
                          >
                            {f.errorMessage}
                          </span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          title="Delete"
                          onClick={() => confirmDelete([f.id])}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-${f.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete filing{pendingDeleteIds.length !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {pendingDeleteIds.length} filing
              {pendingDeleteIds.length !== 1 ? "s" : ""} and their PDF files from disk. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={executeDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
