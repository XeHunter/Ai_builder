/**
 * Live orders feed across POS, self-checkout and online channels.
 *
 * History comes from GET /merchant/channels/orders. Real-time updates come from the merchant's Firestore
 * feed (merchants/{merchantId}/feed) when the deployment has Firebase enabled; otherwise the list is
 * polled. New orders slide in, are highlighted briefly and raise a subtle toast.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Globe, Radio, Receipt, RefreshCw, ScanLine, User } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Tooltip } from "@/components/ui/menu";
import { useAuth } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import { getFirestoreSession } from "@/lib/firebase";
import { cn, formatCurrency, formatDateTime, timeAgo, titleCase } from "@/lib/utils";

import { CHANNEL_META, CHANNELS_KEY, channelLabel, itemSummary, ORDERS_KEY } from "./channel-meta";
import type { ChannelOrder } from "./types";

type Transport = "connecting" | "firestore" | "polling";

interface FeedDoc {
  type?: string;
  sku?: string;
  name?: string;
  on_hand?: number;
  reorder_point?: number;
  store_code?: string;
}

interface StockWarning {
  key: string;
  sku: string;
  name: string;
  onHand: number;
  reorderPoint: number;
  storeCode: string;
}

const CHANNEL_ICON: Record<string, typeof Receipt> = { pos: Receipt, self_checkout: ScanLine, online: Globe };
const HIGHLIGHT_MS = 4000;

function toastChannel(channel: string): string {
  const label = channelLabel(channel);
  return label === "POS" ? label : label.toLowerCase();
}

export interface LiveOrdersFeedProps {
  /** Smaller card for the overview page: fewer rows and a link to the full channels page. */
  compact?: boolean;
  /** Store filter (null / undefined = all stores the user can see). */
  storeId?: string | null;
  /** Polling interval when Firestore is unavailable. */
  pollMs?: number;
  className?: string;
}

export function LiveOrdersFeed({ compact = false, storeId = null, pollMs = 5000, className }: LiveOrdersFeedProps) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [transport, setTransport] = React.useState<Transport>("connecting");
  const [warnings, setWarnings] = React.useState<StockWarning[]>([]);
  const limit = compact ? 8 : 25;

  const q = useQuery({
    queryKey: [...ORDERS_KEY, storeId, limit],
    queryFn: () => api.get<ChannelOrder[]>("/merchant/channels/orders", { store_id: storeId, limit }),
    refetchInterval: transport === "firestore" ? false : pollMs,
    refetchIntervalInBackground: false,
  });

  // ---------------------------------------------------------------- Firestore subscription
  const userId = me?.user.id;
  const merchantId = me?.merchant?.merchant_id;
  React.useEffect(() => {
    if (!userId || !merchantId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void getFirestoreSession(userId).then(async (session) => {
      if (cancelled) return;
      if (!session) {
        setTransport("polling");
        return;
      }
      try {
        const { collection, limit: fsLimit, onSnapshot, orderBy, query } = await import("firebase/firestore");
        if (cancelled) return;
        let initial = true;
        unsubscribe = onSnapshot(
          query(collection(session.db, "merchants", merchantId, "feed"), orderBy("createdAt", "desc"), fsLimit(20)),
          (snap) => {
            // The first snapshot replays history; only react to entries that arrive afterwards.
            if (initial) {
              initial = false;
              return;
            }
            let newOrders = false;
            const lows: StockWarning[] = [];
            for (const change of snap.docChanges()) {
              if (change.type !== "added") continue;
              const d = change.doc.data() as FeedDoc;
              if (d.type === "order") newOrders = true;
              else if (d.type === "low_stock" && d.sku) {
                lows.push({
                  key: change.doc.id,
                  sku: d.sku,
                  name: d.name ?? d.sku,
                  onHand: d.on_hand ?? 0,
                  reorderPoint: d.reorder_point ?? 0,
                  storeCode: d.store_code ?? "",
                });
              }
            }
            if (newOrders) {
              void qc.invalidateQueries({ queryKey: ORDERS_KEY });
              void qc.invalidateQueries({ queryKey: CHANNELS_KEY });
            }
            if (lows.length) {
              for (const w of lows.slice(0, 2)) toast.warning(`Low stock: ${w.name} (${w.onHand} left at ${w.storeCode})`);
              setWarnings((prev) => [...lows, ...prev].slice(0, 3));
            }
          },
          (err) => {
            console.warn("Live feed subscription failed, polling instead:", err);
            setTransport("polling");
          },
        );
        setTransport("firestore");
      } catch (err) {
        console.warn("Firestore unavailable, polling instead:", err);
        if (!cancelled) setTransport("polling");
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [userId, merchantId, qc]);

  // ---------------------------------------------------------------- new-order detection (both transports)
  const seen = React.useRef<{ scope: string; ids: Set<string> } | null>(null);
  const timers = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(() => new Set());
  const scope = `${storeId ?? "all"}:${limit}`;

  React.useEffect(() => {
    const data = q.data;
    if (!data) return;
    if (!seen.current || seen.current.scope !== scope) {
      seen.current = { scope, ids: new Set(data.map((o) => o.id)) };
      return;
    }
    const known = seen.current.ids;
    const added = data.filter((o) => !known.has(o.id));
    data.forEach((o) => known.add(o.id));
    if (!added.length) return;
    const ids = added.map((o) => o.id);
    setFresh((prev) => new Set([...prev, ...ids]));
    for (const o of added.slice(0, 3)) {
      toast(`New ${toastChannel(o.channel)} order ${formatCurrency(o.total)} — ${o.receipt_number}`, {
        description: [o.store_code, itemSummary(o)].filter(Boolean).join(" · "),
      });
    }
    if (added.length > 3) toast(`+${added.length - 3} more new orders`);
    timers.current.push(
      setTimeout(() => {
        setFresh((prev) => {
          const next = new Set(prev);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }, HIGHLIGHT_MS),
    );
  }, [q.data, scope]);

  React.useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  // Keep "x min ago" labels current even when no new data arrives.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const orders = q.data ?? [];

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>{compact ? "Live orders" : "Live orders feed"}</CardTitle>
          <CardDescription>{compact ? "POS, self-checkout and online, as they happen." : "Every bill and online order across channels, newest first."}</CardDescription>
        </div>
        <TransportIndicator transport={transport} pollMs={pollMs} fetching={q.isFetching} />
      </CardHeader>
      <CardContent className={cn("flex-1", compact && "max-h-[26rem] overflow-y-auto")}>
        {warnings.length > 0 && (
          <ul className="mb-3 space-y-1.5" aria-label="Low stock warnings">
            {warnings.map((w) => (
              <li key={w.key} className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-1.5 text-xs">
                <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">Low stock:</span> {w.name} ({w.sku}) at {w.storeCode}: {w.onHand} left, reorder point {w.reorderPoint}
                </span>
                <Link to="/merchant/inventory" className="shrink-0 font-medium text-primary hover:underline">
                  Reorder
                </Link>
              </li>
            ))}
          </ul>
        )}
        {q.isLoading ? (
          <SkeletonRows rows={compact ? 4 : 6} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : orders.length === 0 ? (
          <EmptyState icon={Radio} title="No orders yet" description="Ring up a bill in the POS simulator or connect a POS / online store to see orders stream in." />
        ) : (
          <ul className="space-y-2" aria-live="polite" aria-label="Recent orders">
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} compact={compact} fresh={fresh.has(o.id)} />
            ))}
          </ul>
        )}
      </CardContent>
      {compact && (
        <CardFooter className="justify-end">
          <Button asChild variant="ghost" size="sm">
            <Link to="/merchant/channels">
              Channels & connectors <ArrowRight />
            </Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function TransportIndicator({ transport, pollMs, fetching }: { transport: Transport; pollMs: number; fetching: boolean }) {
  if (transport === "firestore") {
    return (
      <Tooltip content="New orders are pushed from Firestore the moment they are recorded.">
        <span tabIndex={0} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
          <span className="relative flex size-2" aria-hidden>
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          Live · Firestore
        </span>
      </Tooltip>
    );
  }
  if (transport === "polling") {
    return (
      <Tooltip content={`Real-time push is not enabled on this deployment; the feed refreshes every ${Math.round(pollMs / 1000)} s.`}>
        <span tabIndex={0} className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <RefreshCw className={cn("size-3", fetching && "animate-spin")} aria-hidden />
          Auto-refresh
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Radio className="size-3" aria-hidden /> Connecting…
    </span>
  );
}

function OrderRow({ order: o, compact, fresh }: { order: ChannelOrder; compact: boolean; fresh: boolean }) {
  const meta = CHANNEL_META[o.channel] ?? { label: channelLabel(o.channel), variant: "neutral" as const };
  const Icon = CHANNEL_ICON[o.channel] ?? Receipt;
  return (
    <li
      data-fresh={fresh || undefined}
      className={cn(
        "flex items-start gap-3 rounded-md border p-2.5 text-sm transition-all duration-700 starting:-translate-y-2 starting:opacity-0",
        fresh ? "border-primary/40 bg-primary-soft shadow-sm" : "border-border bg-surface",
      )}
    >
      <div className={cn("mt-0.5 rounded-md p-1.5", fresh ? "bg-surface text-primary" : "bg-muted text-muted-foreground")}>
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{o.receipt_number}</span>
          <Badge variant={meta.variant}>{meta.label}</Badge>
          {o.store_code && <Badge variant="outline">{o.store_code}</Badge>}
          {o.is_simulated && <Badge variant="accent">Simulated</Badge>}
          {fresh && (
            <Badge variant="success" className="uppercase tracking-wide">
              New
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-muted-foreground" title={itemSummary(o, 10)}>
          {itemSummary(o, compact ? 2 : 3)}
        </p>
        {!compact && (
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {o.customer && (
              <span className="inline-flex items-center gap-1">
                <User className="size-3" aria-hidden /> {o.customer}
              </span>
            )}
            <span>{titleCase(o.payment_method)}</span>
            <span>
              {o.item_count} item{o.item_count === 1 ? "" : "s"}
            </span>
          </p>
        )}
        {compact && o.customer && <p className="mt-0.5 truncate text-xs text-muted-foreground">{o.customer}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="tabular font-semibold">{formatCurrency(o.total)}</p>
        <time dateTime={o.occurred_at} title={formatDateTime(o.occurred_at)} className="text-xs text-muted-foreground">
          {timeAgo(o.occurred_at)}
        </time>
      </div>
    </li>
  );
}
