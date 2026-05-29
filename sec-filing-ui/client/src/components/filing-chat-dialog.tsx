import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Send, Loader2, MessageSquare, User } from "lucide-react";

type Turn = {
  role: "user" | "assistant";
  content: string;
  // Per-answer metadata shown beneath the response.
  meta?: { costUsd: number; truncated: boolean };
};
type FilingChatResponse = {
  answer: string;
  costUsd: number;
  ticker: string;
  form: string;
  date: string | null;
  truncated: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accession: string;
  ticker: string;
  form: string;
  date: string | null;
};

// Render an assistant turn: split blank-line paragraphs, preserve newlines.
// (No citation badges here — there's only one filing being chatted about.)
function renderAnswer(text: string) {
  return text.split(/\n{2,}/).map((para, i) => (
    <p key={i} className="whitespace-pre-wrap leading-relaxed mb-3 last:mb-0 text-sm">
      {para}
    </p>
  ));
}

export function FilingChatDialog({ open, onOpenChange, accession, ticker, form, date }: Props) {
  const { toast } = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Reset chat state when switching filings or closing.
  useEffect(() => {
    if (!open) {
      setTurns([]);
      setInput("");
    }
  }, [open]);

  const askMutation = useMutation<FilingChatResponse, Error, Turn[]>({
    mutationFn: async (messages) => {
      const res = await apiRequest(
        "POST",
        `/api/filings/${encodeURIComponent(accession)}/ask`,
        { messages },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Chat failed");
      }
      return res.json();
    },
    onSuccess: (data, messages) => {
      setTurns([
        ...messages,
        {
          role: "assistant",
          content: data.answer,
          meta: { costUsd: data.costUsd, truncated: data.truncated },
        },
      ]);
    },
    onError: (err) => {
      toast({ title: "Couldn't get an answer", description: err.message, variant: "destructive" });
      setTurns((t) => (t.length > 0 && t[t.length - 1].role === "user" ? t.slice(0, -1) : t));
    },
  });

  const submit = () => {
    const q = input.trim();
    if (!q || askMutation.isPending) return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setInput("");
    askMutation.mutate(next);
  };

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [turns.length, askMutation.isPending]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="text-base">
            <span className="font-mono mr-2">{ticker}</span>
            <span className="font-normal text-muted-foreground">{form}</span>
            {date && <span className="font-normal text-muted-foreground"> · {date}</span>}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Ask Claude about this filing's full text. Follow-up questions reuse a cached copy of
            the filing, so they're cheap.
          </DialogDescription>
        </DialogHeader>

        <div ref={scrollerRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-[200px]">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Examples: "What does this filing say about price escalators?" · "Summarize the risk
              factors that changed from last year." · "How does the company describe its dealer
              discount program?"
            </p>
          )}
          {turns.map((t, i) => (
            <div key={i} className="flex gap-3">
              <div
                className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                  t.role === "user"
                    ? "bg-muted text-muted-foreground"
                    : "bg-primary/10 text-primary"
                }`}
              >
                {t.role === "user" ? (
                  <User className="w-3.5 h-3.5" />
                ) : (
                  <MessageSquare className="w-3.5 h-3.5" />
                )}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                {t.role === "user" ? (
                  <p className="text-sm font-medium whitespace-pre-wrap leading-relaxed">
                    {t.content}
                  </p>
                ) : (
                  <div>
                    {renderAnswer(t.content)}
                    {t.meta && (
                      <p className="text-[10px] text-muted-foreground/70 mt-1.5" data-testid="filing-answer-cost">
                        cost ${t.meta.costUsd.toFixed(3)}
                        {t.meta.truncated && " · filing text was truncated to fit"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {askMutation.isPending && (
            <div className="flex gap-3">
              <div className="shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <MessageSquare className="w-3.5 h-3.5" />
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Reading the filing…
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Ask about this ${form}…`}
            rows={2}
            className="resize-none"
            disabled={askMutation.isPending}
            data-testid="filing-chat-input"
          />
          <Button
            onClick={submit}
            disabled={askMutation.isPending || !input.trim()}
            data-testid="filing-chat-send"
          >
            {askMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
