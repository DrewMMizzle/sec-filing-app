import { QueryClient, QueryFunction } from "@tanstack/react-query";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export type ApiError = Error & { status: number };

// Surface the server's own message rather than a raw `500: {"error":"…"}`
// string. Routes return `{ error }`; the Express error handler returns
// `{ message }`; zod validation failures return a structured `error` object.
// Anything non-JSON (a proxy's HTML error page, an empty body) falls back to
// the raw text and then the status line, so a caller always gets something
// readable to show the user.
async function throwIfResNotOk(res: Response) {
  if (res.ok) return;

  const raw = await res.text().catch(() => "");
  let message = raw;
  if (raw) {
    try {
      const body = JSON.parse(raw);
      const detail = body?.error ?? body?.message;
      if (typeof detail === "string" && detail.trim()) message = detail;
      else if (detail) message = JSON.stringify(detail);
    } catch {
      // Not JSON — keep the raw body as the message.
    }
  }

  const err = new Error(
    message || res.statusText || `Request failed (${res.status})`,
  ) as ApiError;
  err.status = res.status;
  throw err;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "same-origin",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      credentials: "same-origin",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // A short stale window instead of Infinity. The old default kept large
      // filing/findings payloads resident forever and made every mutation rely
      // on manual invalidation. 30s lets re-mounts pick up fresh data on their
      // own; queries that genuinely need always-fresh polling still set their
      // own refetchInterval.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
