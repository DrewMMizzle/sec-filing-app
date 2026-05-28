import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import Home from "@/pages/home";
import WatchlistPage from "@/pages/watchlist";
import FetchFilings from "@/pages/fetch-filings";
import Findings from "@/pages/findings";
import Compare from "@/pages/compare";
import PdfLibrary from "@/pages/pdf-library";
import Ask from "@/pages/ask";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import NotFound from "@/pages/not-found";

function AuthenticatedApp() {
  const style = {
    "--sidebar-width": "18rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <span className="text-sm font-medium text-muted-foreground">
              SEC Filing Review
            </span>
          </header>
          <main className="flex-1 overflow-auto">
            <Switch>
              <Route path="/" component={Findings} />
              <Route path="/findings" component={Findings} />
              <Route path="/watchlists" component={Home} />
              <Route path="/watchlist/:id" component={WatchlistPage} />
              <Route path="/fetch" component={FetchFilings} />
              <Route path="/compare" component={Compare} />
              <Route path="/ask" component={Ask} />
              <Route path="/library" component={PdfLibrary} />
              {/* If we land on an auth route while already signed in (e.g. the
                  post-login redirect race), bounce home instead of 404ing. */}
              <Route path="/login"><Redirect to="/" /></Route>
              <Route path="/register"><Redirect to="/" /></Route>
              <Route component={NotFound} />
            </Switch>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AppRouter() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/register" component={RegisterPage} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    );
  }

  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Router hook={useHashLocation}>
            <AuthProvider>
              <AppRouter />
              <Toaster />
            </AuthProvider>
          </Router>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
