import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Pencil, Share2, Users, X } from "lucide-react";
import type { Watchlist } from "@shared/schema";

type TickerWithTypes = {
  id: number;
  watchlistId: number;
  ticker: string;
  cik: string;
  filingTypes: string[];
};

type WatchlistDetail = Watchlist & {
  tickers: TickerWithTypes[];
  access: "owner" | "edit" | "view";
  ownerName?: string;
};

type ShareEntry = {
  id: number;
  userId: number;
  email: string;
  displayName: string;
  permission: string;
};

const ALL_FILING_TYPES = ["10-K", "10-Q", "8-K", "DEF 14A", "S-1", "20-F"];

export default function WatchlistPage() {
  const [, params] = useRoute("/watchlist/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const watchlistId = Number(params?.id);

  // State
  const [addOpen, setAddOpen] = useState(false);
  const [tickerInput, setTickerInput] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<string[]>(["10-K", "10-Q", "8-K"]);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTickerId, setDeleteTickerId] = useState<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [sharePermission, setSharePermission] = useState("view");

  // Queries
  const { data: watchlist, isLoading } = useQuery<WatchlistDetail>({
    queryKey: ["/api/watchlists", watchlistId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/watchlists/${watchlistId}`);
      return res.json();
    },
  });

  const tickersQuery = useQuery<TickerWithTypes[]>({
    queryKey: ["/api/watchlists", watchlistId, "tickers"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/watchlists/${watchlistId}/tickers`);
      return res.json();
    },
  });

  const sharesQuery = useQuery<ShareEntry[]>({
    queryKey: ["/api/watchlists", watchlistId, "shares"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/watchlists/${watchlistId}/shares`);
      return res.json();
    },
    enabled: watchlist?.access === "owner",
  });

  const tickers = tickersQuery.data || [];
  const shares = sharesQuery.data || [];
  const isOwner = watchlist?.access === "owner";
  const canEdit = watchlist?.access === "owner" || watchlist?.access === "edit";

  // Mutations
  const addTickerMutation = useMutation({
    mutationFn: async (data: { ticker: string; filingTypes: string[] }) => {
      const res = await apiRequest("POST", `/api/watchlists/${watchlistId}/tickers`, data);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to add ticker");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists", watchlistId, "tickers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists"] });
      setAddOpen(false);
      setTickerInput("");
      setSelectedTypes(["10-K", "10-Q", "8-K"]);
      toast({ title: "Ticker added" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const removeTickerMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/tickers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists", watchlistId, "tickers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists"] });
      setDeleteTickerId(null);
      toast({ title: "Ticker removed" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("PATCH", `/api/watchlists/${watchlistId}`, { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists", watchlistId] });
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists"] });
      setRenameOpen(false);
      toast({ title: "Watchlist renamed" });
    },
  });

  const deleteWatchlistMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/watchlists/${watchlistId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists"] });
      setDeleteOpen(false);
      setLocation("/");
      toast({ title: "Watchlist deleted" });
    },
  });

  const shareMutation = useMutation({
    mutationFn: async (data: { email: string; permission: string }) => {
      const res = await apiRequest("POST", `/api/watchlists/${watchlistId}/share`, data);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Failed to share");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists", watchlistId, "shares"] });
      setShareEmail("");
      setSharePermission("view");
      toast({ title: "Watchlist shared" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const unshareMutation = useMutation({
    mutationFn: async (targetUserId: number) => {
      await apiRequest("DELETE", `/api/watchlists/${watchlistId}/share/${targetUserId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists", watchlistId, "shares"] });
      toast({ title: "Share removed" });
    },
  });

  const handleAddTicker = () => {
    const trimmed = tickerInput.trim().toUpperCase();
    if (!trimmed || selectedTypes.length === 0) return;
    addTickerMutation.mutate({ ticker: trimmed, filingTypes: selectedTypes });
  };

  const toggleType = (type: string) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const handleShare = () => {
    const trimmed = shareEmail.trim();
    if (!trimmed) return;
    shareMutation.mutate({ email: trimmed, permission: sharePermission });
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-muted rounded w-48" />
          <div className="h-4 bg-muted rounded w-32" />
          <div className="h-32 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (!watchlist) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Watchlist not found.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <h1
              className="text-xl font-semibold"
              data-testid="text-watchlist-name"
            >
              {watchlist.name}
            </h1>
            {!isOwner && watchlist.ownerName && (
              <Badge variant="secondary" className="text-xs">
                Shared by {watchlist.ownerName}
              </Badge>
            )}
            {!isOwner && (
              <Badge variant="outline" className="text-xs">
                {watchlist.access}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {tickers.length} ticker{tickers.length !== 1 ? "s" : ""} monitored
          </p>
        </div>
        <div className="flex gap-2">
          {isOwner && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShareOpen(true)}
              >
                <Share2 className="w-3.5 h-3.5 mr-1.5" />
                Share
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setRenameName(watchlist.name);
                  setRenameOpen(true);
                }}
                data-testid="button-rename-watchlist"
              >
                <Pencil className="w-3.5 h-3.5 mr-1.5" />
                Rename
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
                data-testid="button-delete-watchlist"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Add Ticker Button */}
      {canEdit && (
        <Button
          className="mb-4"
          onClick={() => setAddOpen(true)}
          data-testid="button-add-ticker"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          Add Ticker
        </Button>
      )}

      {/* Ticker List */}
      {tickers.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No tickers in this watchlist. {canEdit ? "Add one to start monitoring SEC filings." : ""}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {tickers.map((t) => (
            <Card
              key={t.id}
              className="p-4 flex items-center gap-4"
              data-testid={`card-ticker-${t.ticker}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold font-mono" data-testid={`text-ticker-${t.ticker}`}>
                    {t.ticker}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    CIK {t.cik}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {t.filingTypes.map((ft) => (
                    <Badge
                      key={ft}
                      variant="secondary"
                      className="text-xs"
                      data-testid={`badge-${t.ticker}-${ft}`}
                    >
                      {ft}
                    </Badge>
                  ))}
                </div>
              </div>
              {canEdit && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-muted-foreground shrink-0"
                  onClick={() => setDeleteTickerId(t.id)}
                  data-testid={`button-remove-${t.ticker}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Add Ticker Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Ticker</DialogTitle>
            <DialogDescription>
              Enter a ticker symbol. It will be resolved against the SEC EDGAR database.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAddTicker();
            }}
          >
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1.5 block">Ticker Symbol</label>
                <Input
                  placeholder="e.g. NVDA, TSLA, AMZN"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value)}
                  autoFocus
                  className="font-mono uppercase"
                  data-testid="input-ticker-symbol"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Filing Types</label>
                <div className="flex flex-wrap gap-3">
                  {ALL_FILING_TYPES.map((type) => (
                    <label
                      key={type}
                      className="flex items-center gap-1.5 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedTypes.includes(type)}
                        onCheckedChange={() => toggleType(type)}
                        data-testid={`checkbox-type-${type}`}
                      />
                      {type}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!tickerInput.trim() || selectedTypes.length === 0 || addTickerMutation.isPending}
                data-testid="button-confirm-add-ticker"
              >
                {addTickerMutation.isPending ? "Resolving..." : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Share Dialog */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-4 h-4" />
              Share "{watchlist.name}"
            </DialogTitle>
            <DialogDescription>
              Share this watchlist with other users by email address.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleShare();
            }}
            className="space-y-4"
          >
            <div className="flex gap-2">
              <Input
                placeholder="user@example.com"
                type="email"
                value={shareEmail}
                onChange={(e) => setShareEmail(e.target.value)}
                className="flex-1"
              />
              <Select value={sharePermission} onValueChange={setSharePermission}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view">View</SelectItem>
                  <SelectItem value="edit">Edit</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="submit"
                disabled={!shareEmail.trim() || shareMutation.isPending}
                size="sm"
              >
                Share
              </Button>
            </div>
          </form>

          {/* Current shares list */}
          {shares.length > 0 && (
            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs font-medium text-muted-foreground">Shared with</p>
              {shares.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{s.displayName}</p>
                    <p className="text-xs text-muted-foreground truncate">{s.email}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="outline" className="text-xs">
                      {s.permission}
                    </Badge>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground"
                      onClick={() => unshareMutation.mutate(s.userId)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Watchlist</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (renameName.trim()) renameMutation.mutate(renameName.trim());
            }}
          >
            <Input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              autoFocus
              data-testid="input-rename-watchlist"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="secondary" onClick={() => setRenameOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renameName.trim() || renameMutation.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Watchlist Confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{watchlist.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this watchlist and all its tickers. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteWatchlistMutation.mutate()}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-watchlist"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Ticker Confirm */}
      <AlertDialog open={deleteTickerId !== null} onOpenChange={(open) => { if (!open) setDeleteTickerId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove ticker?</AlertDialogTitle>
            <AlertDialogDescription>
              This ticker will be removed from the watchlist.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTickerId) removeTickerMutation.mutate(deleteTickerId); }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-remove-ticker"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
