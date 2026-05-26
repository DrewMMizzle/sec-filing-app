import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Send, Loader2, Sparkles, User, AlertCircle } from "lucide-react";

type Turn = { role: "user" | "assistant"; content: string };
type ChatResponse = {
  answer: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  costUsd: number;
  corpusFindingsCount: number;
  corpusFilingsCount: number;
  truncated: boolean;
};

const SUGGESTIONS = [
  "Which CEOs are given access to the company jet for personal use?",
  "Show me every related-party transaction involving a director's spouse or family member.",
  "List the largest change-in-control / golden-parachute payouts.",
  "Which filings disclose tax gross-ups for executives?",
  "Which companies had unusually high say-on-pay opposition?",
];

// Render assistant text: split on blank lines into paragraphs, preserve newlines
// inside a paragraph, and turn the [TICKER form date] citations into a faint
// inline badge so they read like citations rather than body text.
function renderAnswer(text: string) {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((para, i) => (
    <p key={i} className="whitespace-pre-wrap leading-relaxed mb-3 last:mb-0">
      {para.split(/(\[[^\]]+\])/g).map((chunk, j) =>
        /^\[[^\]]+\]$/.test(chunk) ? (
          <span
            key={j}
            className="inline-block text-[11px] px-1.5 py-0.5 mx-0.5 rounded bg-primary/10 text-primary font-mono"
          >
            {chunk.slice(1, -1)}
          </span>
        ) : (
          <span key={j}>{chunk}</span>
        ),
      )}
    </p>
  ));
}

export default function Ask() {
  const { toast } = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [lastMeta, setLastMeta] = useState<ChatResponse | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data: config } = useQuery<{ reviewEnabled: boolean }>({
    queryKey: ["/api/config"],
  });
  const reviewEnabled = config?.reviewEnabled ?? false;

  const askMutation = useMutation<ChatResponse, Error, Turn[]>({
    mutationFn: async (messages) => {
      const res = await apiRequest("POST", "/api/findings/chat", { messages });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Chat failed");
      }
      return res.json();
    },
    onSuccess: (data, messages) => {
      setTurns([...messages, { role: "assistant", content: data.answer }]);
      setLastMeta(data);
    },
    onError: (err) => {
      toast({ title: "Couldn't get an answer", description: err.message, variant: "destructive" });
      // Rewind the optimistic user turn so they can edit and retry.
      setTurns((t) => (t.length > 0 && t[t.length - 1].role === "user" ? t.slice(0, -1) : t));
    },
  });

  const submit = (question?: string) => {
    const q = (question ?? input).trim();
    if (!q || askMutation.isPending) return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setInput("");
    askMutation.mutate(next);
  };

  // Scroll to bottom on new turns / while answering.
  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [turns.length, askMutation.isPending]);

  const reset = () => {
    setTurns([]);
    setLastMeta(null);
    setInput("");
  };

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold mb-1" data-testid="text-page-title">
            Ask the findings
          </h1>
          <p className="text-sm text-muted-foreground">
            Claude answers questions across every reviewed finding in your library, citing the
            source filing for each fact.
          </p>
        </div>
        {turns.length > 0 && (
          <Button variant="outline" size="sm" onClick={reset} data-testid="button-reset-chat">
            New chat
          </Button>
        )}
      </div>

      {!reviewEnabled && (
        <Card className="p-3 mb-4 flex items-center gap-2 border-amber-600/30">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Claude is off. Set <code className="text-foreground">ANTHROPIC_API_KEY</code> in the
            environment to enable the chat.
          </p>
        </Card>
      )}

      {/* Chat transcript */}
      <div
        ref={scrollerRef}
        className="flex-1 overflow-y-auto space-y-4 pr-1"
        data-testid="chat-transcript"
      >
        {turns.length === 0 && (
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold">Try one of these</p>
            </div>
            <div className="space-y-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  disabled={!reviewEnabled || askMutation.isPending}
                  className="block w-full text-left text-sm rounded-md border border-border/60 px-3 py-2 hover:bg-muted/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="suggestion"
                >
                  {s}
                </button>
              ))}
            </div>
          </Card>
        )}

        {turns.map((t, i) => (
          <div key={i} className="flex gap-3" data-testid={`turn-${t.role}`}>
            <div
              className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                t.role === "user" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
              }`}
            >
              {t.role === "user" ? <User className="w-3.5 h-3.5" /> : <MessageSquare className="w-3.5 h-3.5" />}
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              {t.role === "user" ? (
                <p className="text-sm font-medium whitespace-pre-wrap leading-relaxed">{t.content}</p>
              ) : (
                <div className="text-sm">{renderAnswer(t.content)}</div>
              )}
            </div>
          </div>
        ))}

        {askMutation.isPending && (
          <div className="flex gap-3" data-testid="turn-loading">
            <div className="shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center">
              <MessageSquare className="w-3.5 h-3.5" />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Searching the findings…
            </div>
          </div>
        )}

        {lastMeta && !askMutation.isPending && (
          <p className="text-[10px] text-muted-foreground/70 pl-10">
            {lastMeta.corpusFindingsCount} findings searched across {lastMeta.corpusFilingsCount}{" "}
            filing{lastMeta.corpusFilingsCount !== 1 ? "s" : ""}
            {lastMeta.truncated && " (older filings omitted)"} · cost ${lastMeta.costUsd.toFixed(3)}
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="mt-3 flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask a question — e.g. 'Which CEOs got tax gross-ups on relocation?'"
          rows={2}
          className="resize-none"
          disabled={!reviewEnabled || askMutation.isPending}
          data-testid="input-question"
        />
        <Button
          onClick={() => submit()}
          disabled={!reviewEnabled || askMutation.isPending || !input.trim()}
          data-testid="button-send"
        >
          {askMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
