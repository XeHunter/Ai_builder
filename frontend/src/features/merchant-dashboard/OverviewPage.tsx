import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  CalendarClock,
  ClipboardList,
  Grid3x3,
  IndianRupee,
  Package,
  PackageX,
  ShieldAlert,
  Tag,
  TrendingDown,
  TrendingUp,
  WandSparkles,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Badge, statusVariant } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, Provenance, StatCard } from "@/components/ui/data";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { axisProps, CHART_COLORS, gridProps, tooltipStyle } from "@/lib/chart";
import { cn, formatCurrency, formatDate, formatNumber } from "@/lib/utils";

import type { Overview } from "./types";

const RANGES = [7, 30, 90] as const;

function compactInr(v: number): string {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(0)}k`;
  return `₹${v}`;
}

export default function OverviewPage() {
  const { storeId, stores } = useMerchantStore();
  const navigate = useNavigate();
  const [days, setDays] = React.useState<number>(30);
  const q = useQuery({
    queryKey: ["merchant", "overview", storeId, days],
    queryFn: () => api.get<Overview>("/merchant/overview", { store_id: storeId, days }),
  });
  const storeName = storeId ? stores.find((s) => s.id === storeId)?.name : "All stores";

  return (
    <div>
      <PageHeader
        eyebrow="Merchant operations"
        title="Overview"
        description={`Live operating picture for ${storeName ?? "the selected store"}: stock, expiry exposure, pricing work and sales.`}
        actions={
          <div className="flex items-center gap-2">
            {q.data?.is_demo_data && <Provenance kind="demo" />}
            <label htmlFor="overview-range" className="sr-only">
              Date range
            </label>
            <Select id="overview-range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
              {RANGES.map((d) => (
                <option key={d} value={d}>
                  Last {d} days
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {q.isLoading ? (
        <OverviewSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data ? (
        <OverviewBody data={q.data} onNavigate={navigate} />
      ) : null}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading overview">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

function OverviewBody({ data, onNavigate }: { data: Overview; onNavigate: (to: string) => void }) {
  const k = data.kpis;
  const change = k.revenue_change_pct;
  const go = (to: string) => () => onNavigate(to);
  return (
    <div className="space-y-6">
      <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Net revenue"
          value={formatCurrency(k.net_revenue, { whole: true })}
          icon={IndianRupee}
          tone={change === null ? "default" : change >= 0 ? "success" : "danger"}
          hint={
            change === null ? (
              "No previous-period sales to compare"
            ) : (
              <span className={cn("inline-flex items-center gap-1", change >= 0 ? "text-success" : "text-danger")}>
                {change >= 0 ? <TrendingUp className="size-3" aria-hidden /> : <TrendingDown className="size-3" aria-hidden />}
                {change > 0 ? "+" : ""}
                {change}% vs previous {data.window_days} days ({formatCurrency(k.net_revenue_previous_period, { whole: true })})
              </span>
            )
          }
        />
        <StatCard label="Transactions" value={formatNumber(k.transactions)} icon={ClipboardList} hint={`Sales and returns in the last ${data.window_days} days`} />
        <StatCard label="Active products" value={formatNumber(k.total_products)} icon={Package} onClick={go("/merchant/catalog")} hint={`${formatNumber(k.total_stock_units)} units in stock`} />
        <StatCard
          label="Low / out of stock"
          value={`${formatNumber(k.low_stock_products)} / ${formatNumber(k.out_of_stock_products)}`}
          icon={PackageX}
          tone={k.out_of_stock_products > 0 ? "danger" : k.low_stock_products > 0 ? "warning" : "success"}
          onClick={go("/merchant/inventory")}
          hint="At or below reorder point / zero on hand"
        />
        <StatCard
          label="Expiring ≤ 3 days"
          value={formatNumber(k.expiring_batches_3d)}
          icon={CalendarClock}
          tone={k.expiring_batches_3d > 0 ? "warning" : "success"}
          onClick={go("/merchant/expiry")}
          hint={`${formatNumber(k.open_store_tasks)} open store tasks`}
        />
        <StatCard
          label="Stockout risk"
          value={`${formatNumber(k.stockout_risk_high)} high`}
          icon={Boxes}
          tone={k.stockout_risk_high > 0 ? "danger" : "default"}
          onClick={go("/merchant/forecasting")}
          hint={`${formatNumber(k.stockout_risk_medium)} medium (latest forecast run)`}
        />
        <StatCard
          label="Pending price recommendations"
          value={formatNumber(k.pending_price_recommendations)}
          icon={WandSparkles}
          tone={k.pending_price_recommendations > 0 ? "warning" : "default"}
          onClick={go("/merchant/pricing")}
          hint={`${formatNumber(k.active_promotions)} active promotions`}
        />
        <StatCard
          label="Merchandising recommendations"
          value={formatNumber(k.pending_merchandising_recommendations)}
          icon={Grid3x3}
          onClick={go("/merchant/merchandising")}
          hint="Proposed, awaiting review"
        />
        <StatCard
          label="Flagged transactions"
          value={formatNumber(k.flagged_transactions)}
          icon={ShieldAlert}
          tone={k.flagged_transactions > 0 ? "danger" : "success"}
          onClick={go("/merchant/fraud")}
          hint="Open, in review or escalated"
        />
        <StatCard label="Active promotions" value={formatNumber(k.active_promotions)} icon={Tag} onClick={go("/merchant/pricing?tab=promotions")} hint="Live, non-simulated" />
        <StatCard
          label="Open store tasks"
          value={formatNumber(k.open_store_tasks)}
          icon={ClipboardList}
          tone={k.open_store_tasks > 0 ? "warning" : "default"}
          onClick={go("/merchant/expiry?tab=tasks")}
          hint="Clearance, relabel and removal work"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Daily revenue & transactions</CardTitle>
            <CardDescription>Gross sales revenue (area) and number of sales per day.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.sales_trend.length === 0 ? (
              <EmptyState title="No sales in this period" description="Sales will appear here once transactions are recorded." />
            ) : (
              <div className="h-72" role="img" aria-label="Daily revenue and transaction trend chart">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data.sales_trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="date" {...axisProps} tickFormatter={(d: string) => formatDate(d)} minTickGap={24} />
                    <YAxis yAxisId="rev" {...axisProps} tickFormatter={compactInr} width={56} />
                    <YAxis yAxisId="txn" orientation="right" {...axisProps} width={40} />
                    <Tooltip
                      {...tooltipStyle}
                      labelFormatter={(d) => formatDate(String(d), { year: "numeric" })}
                      formatter={(v, name) => (name === "Revenue" || name === "Returns" ? formatCurrency(Number(v)) : formatNumber(Number(v)))}
                    />
                    <Area yAxisId="rev" type="monotone" dataKey="revenue" name="Revenue" stroke={CHART_COLORS[0]} fill="url(#revFill)" strokeWidth={2} />
                    <Line yAxisId="txn" type="monotone" dataKey="transactions" name="Transactions" stroke={CHART_COLORS[1]} dot={false} strokeWidth={2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alerts needing action</CardTitle>
            <CardDescription>Critical expiry, high-risk fraud, failed publications and stockouts.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.alerts.length === 0 ? (
              <EmptyState title="Nothing urgent" description="No critical alerts right now." />
            ) : (
              <ul className="space-y-2">
                {data.alerts.map((a, i) => (
                  <li key={`${a.kind}-${i}`}>
                    <Link to={a.link} className="flex items-start gap-3 rounded-md border border-border p-2.5 text-sm transition hover:border-primary/40 hover:bg-muted/50">
                      <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", statusVariant(a.severity) === "danger" ? "text-danger" : "text-warning")} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="mb-0.5 flex items-center gap-1.5">
                          <Badge variant={statusVariant(a.severity) === "neutral" ? "danger" : statusVariant(a.severity)}>{a.severity}</Badge>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">{a.kind}</span>
                        </span>
                        <span className="block">{a.title}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revenue by category</CardTitle>
            <CardDescription>Sales line totals in the last {data.window_days} days.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.category_revenue.length === 0 ? (
              <EmptyState title="No category sales" />
            ) : (
              <div style={{ height: Math.max(200, data.category_revenue.length * 30) }} role="img" aria-label="Revenue by category bar chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.category_revenue} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid {...gridProps} horizontal={false} vertical />
                    <XAxis type="number" {...axisProps} tickFormatter={compactInr} />
                    <YAxis type="category" dataKey="category" {...axisProps} width={150} />
                    <Tooltip {...tooltipStyle} formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="revenue" name="Revenue" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} barSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
            <CardDescription>By revenue in the last {data.window_days} days.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {data.top_products.length === 0 ? (
              <EmptyState title="No product sales" className="mx-5" />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Product</TH>
                    <TH className="text-right">Units</TH>
                    <TH className="text-right">Revenue</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.top_products.map((p, i) => (
                    <TR key={p.product_id}>
                      <TD className="tabular text-muted-foreground">{i + 1}</TD>
                      <TD className="font-medium">{p.name}</TD>
                      <TD className="tabular text-right">{formatNumber(p.units)}</TD>
                      <TD className="tabular text-right">{formatCurrency(p.revenue, { whole: true })}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
