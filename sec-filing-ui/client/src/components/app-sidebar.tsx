import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { List, Plus, FileText, Search, Database } from "lucide-react";

type WatchlistSummary = {
  id: number;
  name: string;
  tickerCount: number;
};

export function AppSidebar() {
  const [location] = useLocation();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const { data: watchlists = [], isLoading } = useQuery<WatchlistSummary[]>({
    queryKey: ["/api/watchlists"],
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/watchlists", { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/watchlists"] });
      setCreateOpen(false);
      setNewName("");
      toast({ title: "Watchlist created" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };

  return (
    <>
      <Sidebar>
        <SidebarHeader className="p-4">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary/10">
              <FileText className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-sidebar-foreground">SEC Filings</p>
              <p className="text-xs text-sidebar-foreground/60">Watchlist Manager</p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          {/* Fetch Filings nav item */}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/fetch"}
                    data-testid="nav-fetch-filings"
                  >
                    <Link href="/fetch">
                      <Search className="w-4 h-4" />
                      <span>Fetch Filings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location === "/library"}
                    data-testid="nav-pdf-library"
                  >
                    <Link href="/library">
                      <Database className="w-4 h-4" />
                      <span>PDF Library</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          {/* Watchlists */}
          <SidebarGroup>
            <SidebarGroupLabel className="flex items-center justify-between pr-2">
              <span>Watchlists</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5 text-sidebar-foreground/60"
                onClick={() => setCreateOpen(true)}
                data-testid="button-create-watchlist"
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {isLoading && (
                  <div className="px-3 py-2 text-xs text-sidebar-foreground/50">Loading...</div>
                )}
                {watchlists.map((wl) => {
                  const isActive = location === `/watchlist/${wl.id}`;
                  return (
                    <SidebarMenuItem key={wl.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        data-testid={`button-watchlist-${wl.id}`}
                      >
                        <Link href={`/watchlist/${wl.id}`}>
                          <List className="w-4 h-4" />
                          <span className="flex-1 truncate">{wl.name}</span>
                          <span className="text-xs tabular-nums text-sidebar-foreground/50">
                            {wl.tickerCount}
                          </span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
                {!isLoading && watchlists.length === 0 && (
                  <div className="px-3 py-4 text-xs text-center text-sidebar-foreground/50">
                    No watchlists yet
                  </div>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-3">
          <p className="text-xs text-sidebar-foreground/40 text-center">
            DotAdda SEC Pipeline
          </p>
        </SidebarFooter>
      </Sidebar>

      {/* Create Watchlist Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Watchlist</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <Input
              placeholder="e.g. Defense, Big Tech, Energy"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              data-testid="input-watchlist-name"
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!newName.trim() || createMutation.isPending}
                data-testid="button-confirm-create"
              >
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
