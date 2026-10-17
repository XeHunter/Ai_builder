/**
 * "Today's AI brief": verified store facts in, prioritised actions out (Gemini when configured).
 * The backend rejects model output that cites unknown facts or invents numbers, so every action is
 * shown with the evidence it was grounded in.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, CalendarClock, Globe, IndianRupee, PackageX, Quote, RefreshCw, ShieldCheck, ShoppingCart, Sparkles } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Tooltip } from "@/components/ui/menu";
import type { AiBrief, BriefAction } from "@/features/channels/types";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatDateTime, formatNumber, timeAgo } from "@/lib/utils";

const PRIORITY: Record<string, { label: string; variant: BadgeVariant; bar: string }> = {
  high: { label: "High priority", variant: "danger", bar: "bg-danger" },
  medium: { label: "Medium", variant: "warning", bar: "bg-warning" },
  low: { label: "Low", variant: "info", bar: "bg-info" },
};

const PROVIDER_NAME: Record<string, string> = { gemini: "Gemini", openai: "OpenAI" };

export function AiBriefCard({ storeId, className }: { storeId: string | null | undefined; className?: string }) {
  const qc = useQueryClient();
  const key = ["merchant", "ai-brief", storeId ?? null] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<AiBrief>("/merchant/ai-brief", { store_id: storeId, refresh: false }),
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => api.get<AiBrief>("/merchant/ai-brief", { store_id: storeId, refresh: true }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      toast.success("AI brief refreshed");
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const data = q.data;

  return (
    <Card className={cn("relative overflow-hidden", className)} role="region" aria-labelledby="ai-brief-title">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary-soft/80 via-surface/40 to-transparent" aria-hidden />
      <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-accent-soft/70 blur-3xl" aria-hidden />
      <div className="relative">
        <div className="flex flex-col gap-3 p-5 pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary p-2.5 text-primary-foreground shadow-sm">
              <Sparkles className="size-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="ai-brief-title" className="text-base font-semibold leading-tight">
                  Today's AI brief
                </h2>
                {data && <ProviderBadge brief={data} />}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {data ? (
                  <>
                    Generated <span title={formatDateTime(data.generated_at)}>{timeAgo(data.generated_at)}</span>
                    {data.cached && " · cached"} · grounded in {data.facts.facts.length} verified fact{data.facts.facts.length === 1 ? "" : "s"} from your store data
                  </>
                ) : (
                  "Prioritised actions from live stock, expiry, pricing and sales facts."
                )}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={q.isLoading || refresh.isPending} className="self-start">
            <RefreshCw className={cn(refresh.isPending && "animate-spin")} aria-hidden /> {refresh.isPending ? "Thinking…" : "Refresh"}
          </Button>
        </div>

        <div className="px-5 pb-5">
          {q.isLoading ? (
            <BriefSkeleton />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : data ? (
            <BriefBody brief={data} dimmed={refresh.isPending} />
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function ProviderBadge({ brief }: { brief: AiBrief }) {
  const name = PROVIDER_NAME[brief.provider];
  if (brief.fell_back) {
    const why = name
      ? `${name} was unavailable or its answer failed fact-checking, so a deterministic ranking of the same facts is shown.`
      : "No AI API key is configured, so a deterministic ranking of the verified facts is shown.";
    return (
      <Tooltip content={why}>
        <span tabIndex={0}>
          <Badge variant="neutral" className="cursor-help">
            <ShieldCheck className="size-3" aria-hidden /> Deterministic fallback
          </Badge>
        </span>
      </Tooltip>
    );
  }
  const label = name ? (brief.model ? `${name} · ${brief.model}` : name) : brief.provider;
  return (
    <Tooltip content="Written by the language model from verified facts only; any number it cannot trace to a fact is rejected.">
      <span tabIndex={0}>
        <Badge variant="primary" className="cursor-help">
          <Bot className="size-3" aria-hidden /> {label}
        </Badge>
      </span>
    </Tooltip>
  );
}

function BriefSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading AI brief">
      <Skeleton className="h-6 w-3/4" />
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-full" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    </div>
  );
}

function KpiChip({ icon: Icon, label, value, tone }: { icon: typeof Sparkles; label: string; value: React.ReactNode; tone?: "warning" | "danger" | "success" }) {
  const toneCls = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-primary";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-2.5 py-1 text-xs">
      <Icon className={cn("size-3.5", toneCls)} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-semibold">{value}</span>
    </span>
  );
}

function BriefBody({ brief, dimmed }: { brief: AiBrief; dimmed: boolean }) {
  const k = brief.facts.kpis ?? {};
  const change = k.revenue_change_pct;
  return (
    <div className={cn("space-y-4 transition-opacity", dimmed && "opacity-60")}>
      <p className="text-lg font-semibold leading-snug text-foreground">{brief.headline}</p>

      <div className="flex flex-wrap gap-2" aria-label="Brief key figures">
        {k.orders_today !== undefined && <KpiChip icon={ShoppingCart} label="Orders today" value={formatNumber(k.orders_today)} />}
        {k.online_orders_today !== undefined && <KpiChip icon={Globe} label="Online" value={formatNumber(k.online_orders_today)} />}
        {k.revenue_7d !== undefined && (
          <KpiChip
            icon={IndianRupee}
            label="Revenue 7d"
            value={
              <>
                {formatCurrency(k.revenue_7d, { whole: true })}
                {change !== null && change !== undefined && (
                  <span className={cn("ml-1 font-medium", change >= 0 ? "text-success" : "text-danger")}>
                    {change > 0 ? "+" : ""}
                    {change}%
                  </span>
                )}
              </>
            }
          />
        )}
        {k.low_stock_products !== undefined && (
          <KpiChip icon={PackageX} label="Low stock" value={formatNumber(k.low_stock_products)} tone={k.low_stock_products > 0 ? "warning" : "success"} />
        )}
        {k.expiring_batches_3d !== undefined && (
          <KpiChip icon={CalendarClock} label="Expiring ≤ 3d" value={formatNumber(k.expiring_batches_3d)} tone={k.expiring_batches_3d > 0 ? "danger" : "success"} />
        )}
      </div>

      {brief.actions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-muted-foreground">Nothing needs your attention right now. Enjoy the quiet day.</p>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2" aria-label="Recommended actions">
          {brief.actions.map((a, i) => (
            <ActionItem key={`${a.title}-${i}`} action={a} index={i} />
          ))}
        </ol>
      )}
    </div>
  );
}

function ActionItem({ action: a, index }: { action: BriefAction; index: number }) {
  const p = PRIORITY[a.priority] ?? PRIORITY.low;
  return (
    <li className="relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface p-3.5 pl-4 shadow-[var(--shadow-card)] transition hover:border-primary/40 hover:shadow-md">
      <span className={cn("absolute inset-y-0 left-0 w-1", p.bar)} aria-hidden />
      <div className="flex items-start gap-2.5">
        <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={p.variant}>{p.label}</Badge>
          </div>
          <p className="mt-1 font-medium leading-snug">{a.title}</p>
          {a.detail && <p className="mt-0.5 text-sm text-foreground/80">{a.detail}</p>}
          {a.evidence.length > 0 && (
            <ul className="mt-2 space-y-1" aria-label="Evidence">
              {a.evidence.map((e, j) => (
                <li key={j} className="flex gap-1.5 text-xs text-muted-foreground">
                  <Quote className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {a.link && (
        <div className="mt-3 flex justify-end">
          <Button asChild variant="ghost" size="sm" className="text-primary">
            <Link to={a.link} aria-label={`${a.title}: open`}>
              Take action <ArrowRight />
            </Link>
          </Button>
        </div>
      )}
    </li>
  );
}
