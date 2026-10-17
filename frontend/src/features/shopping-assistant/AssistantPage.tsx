import { useMutation } from "@tanstack/react-query";
import { Bot, Package, Send, UserRound, X } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/data";
import { ErrorState, Spinner } from "@/components/ui/feedback";
import { Textarea } from "@/components/ui/input";
import { useShopperStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn, uid } from "@/lib/utils";
import type { AssistantResponse, ProductSearchResponse } from "@/types/api";

import { AssistantReply } from "./components/AssistantReply";
import { useProductDetail } from "./hooks";

type Message =
  | { id: string; role: "user"; text: string; contextName?: string }
  | { id: string; role: "assistant"; response: AssistantResponse }
  | { id: string; role: "error"; error: unknown; retry: { text: string; contextId: string | null } };

const CAMERA_PROMPT = "Which compatible memory card goes with this camera?";
const PROMPTS = [
  "I need breakfast items for two people under ₹500.",
  "Where can I find milk?",
  CAMERA_PROMPT,
  "Find a product similar to Tata Tea",
];

export default function AssistantPage() {
  const { store, storeId } = useShopperStore();
  const [params, setParams] = useSearchParams();
  const contextId = params.get("product");
  const context = useProductDetail(storeId, contextId);
  const contextName = context.data?.product.name;
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [draft, setDraft] = React.useState("");
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // A new store means a new catalog: start a fresh conversation.
  React.useEffect(() => {
    setMessages([]);
  }, [storeId]);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  const chat = useMutation({
    mutationFn: (vars: { text: string; contextId: string | null }) =>
      api.post<AssistantResponse>("/assistant/chat", { store_id: storeId, message: vars.text, context_product_id: vars.contextId ?? undefined }),
    onSuccess: (response) => setMessages((m) => [...m, { id: uid(), role: "assistant", response }]),
    onError: (error, vars) => setMessages((m) => [...m, { id: uid(), role: "error", error, retry: vars }]),
  });

  const setContext = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("product", id);
    else next.delete("product");
    setParams(next, { replace: true });
  };

  const send = async (text: string, ctx: string | null = contextId, ctxName = contextName) => {
    const clean = text.trim();
    if (!clean || !storeId || chat.isPending) return;
    setMessages((m) => [...m, { id: uid(), role: "user", text: clean, contextName: ctx ? ctxName : undefined }]);
    setDraft("");
    chat.mutate({ text: clean, contextId: ctx });
  };

  const askPrompt = async (prompt: string) => {
    // The camera prompt needs a camera as context. Without one, look up the Canon camera in this store's catalog.
    if (prompt === CAMERA_PROMPT && !contextId && storeId) {
      try {
        const res = await api.get<ProductSearchResponse>(`/stores/${storeId}/products`, { q: "canon camera", page_size: 5 });
        const camera = res.items.find((p) => /canon/i.test(p.name)) ?? res.items[0];
        if (camera) {
          setContext(camera.id);
          return send(prompt, camera.id, camera.name);
        }
      } catch {
        /* fall through and ask without context */
      }
    }
    return send(prompt);
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col">
      <PageHeader
        eyebrow={store?.name}
        title="Shopping assistant"
        description="Ask for meal baskets on a budget, where to find things, compatible accessories or alternatives. Answers use this store's live catalog, prices, stock and shelf locations."
      />

      <div className="flex min-h-[50vh] flex-col rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
        <div className="flex-1 space-y-5 p-4 sm:p-5" role="log" aria-live="polite" aria-label="Conversation">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="rounded-full bg-primary-soft p-3 text-primary">
                <Bot className="size-6" aria-hidden />
              </span>
              <p className="max-w-md text-sm text-muted-foreground">Try one of these to get started, or type your own question below.</p>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end gap-2">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
                  {m.text}
                  {m.contextName && <span className="mt-1 block text-xs opacity-80">About: {m.contextName}</span>}
                </div>
                <UserRound className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />
              </div>
            ) : m.role === "assistant" ? (
              <div key={m.id} className="flex gap-2">
                <Bot className="mt-1 size-5 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border bg-surface-raised p-3 sm:p-4">
                  <AssistantReply response={m.response} onQuickReply={(t) => send(t)} />
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex gap-2">
                <Bot className="mt-1 size-5 shrink-0 text-danger" aria-hidden />
                <ErrorState
                  className="flex-1"
                  error={m.error}
                  onRetry={() => {
                    setMessages((all) => all.filter((x) => x.id !== m.id));
                    chat.mutate(m.retry);
                  }}
                />
              </div>
            ),
          )}
          {chat.isPending && (
            <div className="flex gap-2">
              <Bot className="mt-1 size-5 shrink-0 text-primary" aria-hidden />
              <Spinner label="Checking the catalog" className="rounded-2xl border border-border bg-surface-raised px-4 py-2" />
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="space-y-3 border-t border-border p-3 sm:p-4">
          <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
            {PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={chat.isPending || !storeId}
                onClick={() => void askPrompt(p)}
                className="rounded-full border border-border-strong bg-surface px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {p}
              </button>
            ))}
          </div>
          {contextId && (
            <div className="flex items-center gap-2">
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent-soft py-1 pl-3 pr-1 text-xs text-accent">
                <Package className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">
                  Asking about: {context.isLoading ? "loading…" : contextName ?? (context.isError ? "unknown product" : "product")}
                </span>
                <button
                  type="button"
                  onClick={() => setContext(null)}
                  className="rounded-full p-0.5 hover:bg-accent/10"
                  aria-label="Remove product context"
                >
                  <X className="size-3.5" />
                </button>
              </span>
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
          >
            <Textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(draft);
                }
              }}
              rows={1}
              maxLength={1000}
              placeholder="Ask about products, budgets, or where to find something…"
              aria-label="Message the shopping assistant"
              className={cn("min-h-11 resize-none")}
            />
            <Button type="submit" size="lg" disabled={!draft.trim() || !storeId} loading={chat.isPending} aria-label="Send message">
              <Send aria-hidden />
              <span className="hidden sm:inline">Send</span>
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
