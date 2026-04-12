import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import Home from "@/pages/home";
import WatchlistPage from "@/pages/watchlist";
import FetchFilings from "@/pages/fetch-filings";
import PdfLibrary from "@/pages/pdf-library";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/watchlist/:id" component={WatchlistPage} />
      <Route path="/fetch" component={FetchFilings} />
      <Route path="/library" component={PdfLibrary} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  const style = {
    "--sidebar-width": "18rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router hook={useHashLocation}>
          <SidebarProvider style={style as React.CSSProperties}>
            <div className="flex h-screen w-full">
              <AppSidebar />
              <div className="flex flex-col flex-1 min-w-0">
                <header className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm">
                  <SidebarTrigger data-testid="button-sidebar-toggle" />
                  <span className="text-sm font-medium text-muted-foreground">
                    SEC Filing Watchlist
                  </span>
                </header>
                <main className="flex-1 overflow-auto">
                  <AppRouter />
                </main>
              </div>
            </div>
          </SidebarProvider>
          <Toaster />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
