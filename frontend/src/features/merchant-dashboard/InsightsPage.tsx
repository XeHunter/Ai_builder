/** Shopping insights: store traffic patterns, channel mix, basket sizes and shopping-list demand signals (aggregated). */
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, SearchX, Share2, ShieldCheck, CheckCircle2 } from "lucide-react";
import * as React from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout, EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/input";
import { PageHeader, Provenance, StatCard } from "@/components/ui/data";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { axisProps, CHART_COLORS, gridProps, tooltipStyle } from "@/lib/chart";
import { formatNumber, titleCase } from "@/lib/utils";

import { TrafficHeatmap, type TrafficCell } from "./insights/TrafficHeatmap";

interface Insights {
  window_days: number;
  traffic_heatmap: TrafficCell[];
  channel_mix: { channel: string; transactions: number }[];
  basket_size_distribution: { items: number; transactions: number }[];
  shopping_lists: { total: number; shared: number; completed: number };
  catalog_gaps: { query: string; count: number }[];
  most_listed_products: { name: string; count: number }[];
  privacy_note: string;
}

const CHANNEL_LABEL: Record<string, string> = { pos: "Staffed POS", self_checkout: "Self-checkout", online: "Online" };

export default function InsightsPage() {
  const { storeId, stores } = useMerchantStore();
  const [days, setDays] = React.useState(30);
  const q = useQuery({
    queryKey: ["merchant", "insights", storeId, days],
    queryFn: () => api.get<Insights>("/merchant/insights", { store_id: storeId, days }),
    placeholderData: (p) => p,
  });
  const scope = storeId ? stores.find((s) => s.id === storeId)?.name ?? "Selected store" : "All stores";

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Shopping insights"
        description={`When and how customers shop, and what they look for: ${scope}.`}
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="ins-days" className="text-sm font-medium">Window</label>
            <Select id="ins-days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
              {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </Select>
          </div>
        }
      />
      {q.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 lg:col-span-2" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <InsightsBody data={q.data!} />
      )}
    </>
  );
}

function InsightsBody({ data }: { data: Insights }) {
  const totalTx = data.channel_mix.reduce((n, c) => n + c.transactions, 0);
  const channels = data.channel_mix
    .map((c) => ({ ...c, label: CHANNEL_LABEL[c.channel] ?? titleCase(c.channel), share: totalTx ? (c.transactions / totalTx) * 100 : 0 }))
    .sort((a, b) => b.transactions - a.transactions);
  const basketTotal = data.basket_size_distribution.reduce((n, b) => n + b.transactions, 0);
  const avgBasket = basketTotal ? data.basket_size_distribution.reduce((n, b) => n + b.items * b.transactions, 0) / basketTotal : null;
  const sl = data.shopping_lists;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Store traffic</CardTitle>
            <CardDescription>Sale transactions by weekday and hour (store local time), last {data.window_days} days.</CardDescription>
          </div>
          <Provenance kind="demo" detail="Computed from the seeded (synthetic) transaction history." />
        </CardHeader>
        <CardContent>
          <TrafficHeatmap cells={data.traffic_heatmap} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Channel mix</CardTitle>
            <CardDescription>{formatNumber(totalTx)} sale transactions</CardDescription>
          </CardHeader>
          <CardContent>
            {!channels.length ? (
              <EmptyState title="No transactions" />
            ) : (
              <figure aria-label={channels.map((c) => `${c.label} ${c.share.toFixed(1)}%`).join(", ")}>
                <div className="h-48" aria-hidden>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={channels} layout="vertical" margin={{ top: 0, right: 56, left: 8, bottom: 0 }}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="label" {...axisProps} width={96} />
                      <Tooltip {...tooltipStyle} cursor={{ fill: "#f1f3f6" }} formatter={(v) => [formatNumber(Number(v)), "Transactions"]} />
                      <Bar dataKey="transactions" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
                        <LabelList dataKey="share" position="right" formatter={(v) => `${Number(v).toFixed(1)}%`} style={{ fontSize: 12, fill: "#111827" }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <table className="sr-only">
                  <caption>Channel mix</caption>
                  <tbody>{channels.map((c) => <tr key={c.channel}><th scope="row">{c.label}</th><td>{c.transactions}</td><td>{c.share.toFixed(1)}%</td></tr>)}</tbody>
                </table>
              </figure>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Basket size</CardTitle>
            <CardDescription>Items per sale transaction{avgBasket != null && ` · average ${avgBasket.toFixed(1)}`}</CardDescription>
          </CardHeader>
          <CardContent>
            {!data.basket_size_distribution.length ? (
              <EmptyState title="No transactions" />
            ) : (
              <figure aria-label={`Basket size distribution, average ${avgBasket?.toFixed(1)} items`}>
                <div className="h-48" aria-hidden>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.basket_size_distribution} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                      <CartesianGrid {...gridProps} />
                      <XAxis dataKey="items" {...axisProps} />
                      <YAxis {...axisProps} />
                      <Tooltip {...tooltipStyle} cursor={{ fill: "#f1f3f6" }} labelFormatter={(l) => `${l} item${l === 1 ? "" : "s"}`} formatter={(v) => [formatNumber(Number(v)), "Transactions"]} />
                      <Bar dataKey="transactions" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <table className="sr-only">
                  <caption>Transactions by basket size</caption>
                  <tbody>{data.basket_size_distribution.map((b) => <tr key={b.items}><th scope="row">{b.items} items</th><td>{b.transactions}</td></tr>)}</tbody>
                </table>
              </figure>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Shopping lists" value={formatNumber(sl.total)} icon={ClipboardList} hint="Lists created for these stores (all time)" />
        <StatCard label="Shared lists" value={formatNumber(sl.shared)} icon={Share2} hint={sl.total ? `${((sl.shared / sl.total) * 100).toFixed(0)}% of lists` : undefined} />
        <StatCard label="Completed lists" value={formatNumber(sl.completed)} icon={CheckCircle2} tone="success" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><SearchX className="size-4" aria-hidden /> Catalog gaps</CardTitle>
            <CardDescription>Products shoppers asked for in their lists that you don’t sell (unresolved list items).</CardDescription>
          </CardHeader>
          <CardContent>
            <CountList items={data.catalog_gaps.map((g) => ({ label: g.query, count: g.count }))} empty="No unresolved list items. Every requested item matched the catalogue." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ClipboardList className="size-4" aria-hidden /> Most listed products</CardTitle>
            <CardDescription>Catalogue products most often added to shopping lists.</CardDescription>
          </CardHeader>
          <CardContent>
            <CountList items={data.most_listed_products.map((g) => ({ label: g.name, count: g.count }))} empty="No list items matched to products yet." />
          </CardContent>
        </Card>
      </div>

      <Callout title="Privacy">
        <span className="inline-flex items-start gap-1.5"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />{data.privacy_note}</span>
      </Callout>
    </div>
  );
}

function CountList({ items, empty }: { items: { label: string; count: number }[]; empty: string }) {
  if (!items.length) return <p className="py-4 text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(...items.map((i) => i.count));
  return (
    <ol className="flex flex-col gap-2">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-sm">
          <span className="truncate first-letter:uppercase">{i.label}</span>
          <span className="tabular text-right font-medium">{i.count}</span>
          <span className="col-span-2 mt-1 h-1 rounded-full bg-muted" aria-hidden>
            <span className="block h-full rounded-full bg-primary/70" style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}
