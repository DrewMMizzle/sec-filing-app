import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Top-level error boundary so an uncaught render error surfaces as a visible
// message instead of an all-black shell with no console output. Wraps the
// router so any route component's crash is contained at this level.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full rounded-md border border-destructive/30 bg-destructive/5 p-5">
          <h1 className="text-base font-semibold mb-1">Something went wrong</h1>
          <p className="text-sm text-muted-foreground mb-3">
            The page hit an unexpected error. Reload to try again — and if it keeps happening,
            copy the message below into a bug report.
          </p>
          <pre className="text-xs bg-background/50 border border-border rounded p-2 mb-3 overflow-auto max-h-40 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-sm rounded-md border border-border px-3 py-1.5 hover:bg-muted/40"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
