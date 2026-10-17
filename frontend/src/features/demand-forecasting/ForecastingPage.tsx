/** Demand forecasting: runs, per-product stockout risk and reorder suggestions, and product drill-down charts. */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, LineChart as LineChartIcon, PackageX, Plus, Target } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, EmptyState, ErrorState, Progress, Skeleton, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { KeyValue, PageHeader, Provenance, StatCard } from "@/components/ui/data";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { useJob } from "@/hooks/use-job";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { cn, formatDate, formatDateTime, formatNumber, timeAgo } from "@/lib/utils";

import { ForecastChart } from "./ForecastChart";
import { MODEL_LABEL, type ForecastRun, type ForecastRunDetail, type ProductSeries, type ProductSummary, type Risk } from "./types";

export const forecastSchema = z.object({
  store_id: z.string().min(1, "Choose a store"),
  horizon_days: z.number({ message: "Enter a number" }).int().min(1, "At least 1 day").max(60, "At most 60 days"),
  history_days: z.number({ message: "Enter a number" }).int().min(35, "At least 35 days").max(730, "At most 730 days"),
  model: z.enum(["", "seasonal_naive", "weather_ridge"]),
});
type ForecastForm = z.infer<typeof forecastSchema>;

export default function ForecastingPage() {
  const { storeId, concreteStoreId } = useMerchantStore();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [formOpen, setFormOpen] = React.useState(false);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = React.useState<string | null>(null);

  const runs = useQuery({
    queryKey: ["merchant", "forecast-runs", storeId],
    queryFn: () => api.get<ForecastRun[]>("/merchant/forecasts", { store_id: storeId }),
  });
  const paramRun = params.get("run");
  const selectedId = paramRun ?? runs.data?.find((r) => r.status === "succeeded")?.id ?? runs.data?.[0]?.id ?? null;
  const selectRun = (id: string) => setParams((p) => { const n = new URLSearchParams(p); n.set("run", id); return n; }, { replace: true });

  const job = useJob(jobId);
  React.useEffect(() => {
    const st = job.data?.status;
    if (!st || !jobId) return;
    if (st === "succeeded") {
      toast.success("Forecast run finished");
      void qc.invalidateQueries({ queryKey: ["merchant", "forecast-runs"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "forecast-run"] });
      if (pendingRunId) selectRun(pendingRunId);
      setJobId(null);
    } else if (st === "failed") {
      toast.error(`Forecast run failed: ${job.data?.error ?? "unknown error"}`);
      void qc.invalidateQueries({ queryKey: ["merchant", "forecast-runs"] });
      setJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.status, jobId]);

  const create = useMutation({
    mutationFn: (v: ForecastForm) => api.post<ForecastRun>("/merchant/forecasts", { ...v, model: v.model || null }),
    onSuccess: (r) => {
      toast.info("Forecast queued. Backtesting models per product…");
      setFormOpen(false);
      setJobId(r.job_id ?? null);
      setPendingRunId(r.id);
      void qc.invalidateQueries({ queryKey: ["merchant", "forecast-runs"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader
        eyebrow="Planning"
        title="Demand forecasting"
        description="Per-product daily demand forecasts with backtested model selection, stockout risk, days of cover and reorder suggestions."
        actions={
          can("forecast.run") && (
            <Button onClick={() => setFormOpen(true)} disabled={!!jobId}>
              <Plus /> New forecast
            </Button>
          )
        }
      />

      {jobId && (
        <Card className="mb-4">
          <CardContent className="flex flex-col gap-2 pt-5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Forecast job {job.data?.status ?? "queued"}…</span>
              <StatusBadge status={job.data?.status ?? "queued"} />
            </div>
            <Progress value={job.data?.status === "running" ? 60 : 20} label="Forecast job progress" />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Runs</CardTitle>
            <CardDescription>Latest 30 for {storeId ? "this store" : "all stores"}</CardDescription>
          </CardHeader>
          <CardContent>
            {runs.isLoading ? (
              <SkeletonRows rows={5} />
            ) : runs.isError ? (
              <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
            ) : !runs.data?.length ? (
              <EmptyState icon={LineChartIcon} title="No forecast runs" description="Create a forecast to see stockout risks." />
            ) : (
              <ul className="flex max-h-[560px] flex-col gap-1 overflow-y-auto" aria-label="Forecast runs">
                {runs.data.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => selectRun(r.id)}
                      aria-current={r.id === selectedId}
                      className={cn("w-full rounded-md border px-3 py-2 text-left text-sm", r.id === selectedId ? "border-primary bg-primary-soft" : "border-transparent hover:bg-muted")}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{r.store_code} · {r.horizon_days} d</span>
                        <StatusBadge status={r.status} />
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {formatDateTime(r.created_at)} · {r.history_days} d history
                        {r.params?.model ? ` · ${MODEL_LABEL[r.params.model] ?? r.params.model} only` : ""}
                        {r.params?.scheduled ? " · scheduled" : ""}
                      </span>
                      {r.status === "succeeded" && (r.metrics.high_risk ?? 0) > 0 && (
                        <span className="mt-1 inline-flex items-center gap-1 text-xs text-danger">
                          <AlertTriangle className="size-3" aria-hidden /> {r.metrics.high_risk} high risk
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <div className="min-w-0">{selectedId ? <RunDetail runId={selectedId} /> : !runs.isLoading && <EmptyState title="Select a run" />}</div>
      </div>

      <NewForecastDialog open={formOpen} onOpenChange={setFormOpen} defaultStore={concreteStoreId} submitting={create.isPending} onSubmit={(v) => create.mutate(v)} />
    </>
  );
}

function NewForecastDialog({ open, onOpenChange, defaultStore, submitting, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; defaultStore: string | null; submitting: boolean; onSubmit: (v: ForecastForm) => void;
}) {
  const { stores } = useMerchantStore();
  const form = useForm<ForecastForm>({
    resolver: zodResolver(forecastSchema),
    defaultValues: { store_id: defaultStore ?? "", horizon_days: 14, history_days: 120, model: "" },
  });
  React.useEffect(() => {
    if (open) form.reset({ store_id: defaultStore ?? stores[0]?.id ?? "", horizon_days: 14, history_days: 120, model: "" });
  }, [open, defaultStore, stores, form]);
  const e = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New forecast run" description="Runs in the background. Each product is backtested on its last 14 days and the lower-error model is used." size="md">
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          <Field label="Store" htmlFor="fc-store" error={e.store_id?.message}>
            <Select id="fc-store" {...form.register("store_id")}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Horizon (days)" htmlFor="fc-horizon" error={e.horizon_days?.message} hint="1 – 60">
              <Input id="fc-horizon" type="number" min={1} max={60} aria-invalid={!!e.horizon_days} {...form.register("horizon_days", { valueAsNumber: true })} />
            </Field>
            <Field label="History (days)" htmlFor="fc-history" error={e.history_days?.message} hint="35 – 730">
              <Input id="fc-history" type="number" min={35} max={730} aria-invalid={!!e.history_days} {...form.register("history_days", { valueAsNumber: true })} />
            </Field>
          </div>
          <Field label="Model" htmlFor="fc-model" hint="Auto-select backtests both models per product. Weather ridge needs ≥ 42 days of history and enough volume.">
            <Select id="fc-model" {...form.register("model")}>
              <option value="">Auto-select (recommended)</option>
              <option value="seasonal_naive">Seasonal naive only (baseline)</option>
              <option value="weather_ridge">Weather ridge only (where eligible)</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Run forecast
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const RISKS: Risk[] = ["high", "medium", "low", "none"];

function RunDetail({ runId }: { runId: string }) {
  const [risk, setRisk] = React.useState<string>("");
  const [productId, setProductId] = React.useState<string | null>(null);
  const q = useQuery({
    queryKey: ["merchant", "forecast-run", runId, risk],
    queryFn: () => api.get<ForecastRunDetail>(`/merchant/forecasts/${runId}`, { risk: risk || undefined }),
    refetchInterval: (query) => (query.state.data && ["queued", "running"].includes(query.state.data.status) ? 2000 : false),
  });

  if (q.isLoading) return <Skeleton className="h-[480px] w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const run = q.data!;
  if (run.status === "failed") return <ErrorState error={new Error(run.error ?? "The forecast run failed.")} />;
  if (run.status !== "succeeded") {
    return <EmptyState icon={CalendarClock} title={`Run ${run.status}`} description="Results appear here when the background job finishes." />;
  }
  const m = run.metrics;
  const sel = m.selected_vs_baseline_mae;
  const improvement = sel && sel.baseline > 0 ? ((sel.baseline - sel.selected) / sel.baseline) * 100 : null;
  const models = Object.keys({ ...(m.mean_mae_by_model ?? {}), ...(m.model_wins ?? {}) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{run.store_code}</span>
        <span className="text-muted-foreground">
          {run.horizon_days}-day horizon from {formatDate(run.finished_at ?? run.created_at)} · {run.history_days} days history · finished {timeAgo(run.finished_at)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {run.weather_source === "simulated" ? (
            <Provenance kind="simulated" detail="Weather history and forecast come from the deterministic weather simulator (no live weather API configured)." />
          ) : (
            <Badge variant="info">Weather: {run.weather_source ?? "unknown"}</Badge>
          )}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Products forecast" value={formatNumber(m.products)} icon={Target} />
        <StatCard label="High stockout risk" value={formatNumber(m.high_risk)} tone="danger" icon={PackageX} hint="Runs out within lead time (2 d)" onClick={() => setRisk(risk === "high" ? "" : "high")} />
        <StatCard label="Medium risk" value={formatNumber(m.medium_risk)} tone="warning" icon={AlertTriangle} hint="Runs out within 7 days" onClick={() => setRisk(risk === "medium" ? "" : "medium")} />
        <StatCard
          label="Total backtest MAE"
          value={sel ? formatNumber(sel.selected, 1) : "—"}
          tone="success"
          hint={sel ? `vs ${formatNumber(sel.baseline, 1)} baseline${improvement != null ? ` (${improvement >= 0 ? "−" : "+"}${Math.abs(improvement).toFixed(1)}%)` : ""}` : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Model selection</CardTitle>
          <CardDescription>Wins = products where the model had the lower backtest MAE and was used for the horizon.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH className="text-right">Wins</TH>
                <TH className="text-right">Backtested</TH>
                <TH className="text-right">Mean MAE</TH>
              </TR>
            </THead>
            <TBody>
              {models.map((k) => (
                <TR key={k}>
                  <TD>
                    <span className="flex items-center gap-2">
                      {MODEL_LABEL[k] ?? k} <Provenance kind={k === "weather_ridge" ? "ml" : "statistical"} detail={modelDetail(k)} />
                    </span>
                  </TD>
                  <TD className="tabular text-right">{m.model_wins?.[k] ?? 0}</TD>
                  <TD className="tabular text-right">{m.products_backtested_by_model?.[k] ?? "—"}</TD>
                  <TD className="tabular text-right">{m.mean_mae_by_model?.[k]?.toFixed(3) ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Callout title="How accuracy is measured">
            Each product’s final {run.backtest_days} days are held out: models are fitted on the earlier history and scored on
            the hold-out by mean absolute error (units/day). Backtests use the weather that was actually observed, so live
            accuracy also depends on weather-forecast quality. Rain effects are associations in past sales, not proof of cause.
            Intervals are approximate 80% bands (±1.28σ of residuals).
          </Callout>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle>Products by stockout risk</CardTitle>
            <CardDescription>Sorted by risk, then forecast volume. Select a product to see observed sales vs forecast.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="risk-filter" className="text-sm font-medium">Risk</label>
            <Select id="risk-filter" value={risk} onChange={(e) => setRisk(e.target.value)} className="w-36">
              <option value="">All</option>
              {RISKS.map((r) => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </Select>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {!run.products.length ? (
            <EmptyState title="No products match this filter" className="mx-5" />
          ) : (
            <ProductsTable products={run.products} onSelect={setProductId} />
          )}
        </CardContent>
      </Card>

      <Dialog open={!!productId} onOpenChange={(o) => !o && setProductId(null)}>
        {productId && (
          <DialogContent side="right" size="xl" title={run.products.find((p) => p.product_id === productId)?.name ?? "Product forecast"} description={`Run ${run.store_code} · ${run.horizon_days}-day horizon`}>
            <ProductDrilldown runId={runId} summary={run.products.find((p) => p.product_id === productId)} productId={productId} weatherSource={run.weather_source} />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function modelDetail(model: string): string {
  return model === "weather_ridge"
    ? "scikit-learn Ridge regression on weekday, trend, precipitation, rain flag, max temperature and holiday features."
    : "Deterministic baseline: mean of the last 4 same-weekday observations.";
}

export function ProductsTable({ products, onSelect }: { products: ProductSummary[]; onSelect: (id: string) => void }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Product</TH>
          <TH>Risk</TH>
          <TH className="text-right">Forecast total</TH>
          <TH className="text-right">Avg/day (28 d)</TH>
          <TH className="text-right">Stock</TH>
          <TH className="text-right">Days cover</TH>
          <TH>Stockout</TH>
          <TH className="text-right">Reorder</TH>
          <TH>Model</TH>
          <TH className="text-right">MAE / baseline</TH>
        </TR>
      </THead>
      <TBody>
        {products.map((p) => {
          const better = p.mae != null && p.baseline_mae != null && p.mae < p.baseline_mae;
          return (
            <TR key={p.product_id} className="cursor-pointer" onClick={() => onSelect(p.product_id)} data-testid="forecast-row">
              <TD>
                <button type="button" className="text-left font-medium hover:underline" onClick={(e) => { e.stopPropagation(); onSelect(p.product_id); }}>
                  {p.name}
                </button>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {p.sku}
                  {p.overstock && <Badge variant="warning">Overstock</Badge>}
                </span>
              </TD>
              <TD><StatusBadge status={p.stockout_risk} /></TD>
              <TD className="tabular text-right">{formatNumber(p.horizon_total, 1)}</TD>
              <TD className="tabular text-right">{formatNumber(p.avg_daily_history, 1)}</TD>
              <TD className="tabular text-right">{formatNumber(p.current_stock)}</TD>
              <TD className={cn("tabular text-right", p.days_of_cover != null && p.days_of_cover < 3 && "font-semibold text-danger")}>
                {p.days_of_cover == null ? "—" : p.days_of_cover.toFixed(1)}
              </TD>
              <TD className="whitespace-nowrap">{p.stockout_date ? formatDate(p.stockout_date, { weekday: "short" }) : "—"}</TD>
              <TD className="tabular text-right font-medium">{p.recommended_reorder_qty ? formatNumber(p.recommended_reorder_qty) : "—"}</TD>
              <TD className="whitespace-nowrap text-xs">{MODEL_LABEL[p.model_used] ?? p.model_used}</TD>
              <TD className="tabular whitespace-nowrap text-right text-xs">
                <span className={better ? "text-success" : undefined}>{p.mae?.toFixed(2) ?? "—"}</span>
                <span className="text-muted-foreground"> / {p.baseline_mae?.toFixed(2) ?? "—"}</span>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

function ProductDrilldown({ runId, productId, summary, weatherSource }: { runId: string; productId: string; summary?: ProductSummary; weatherSource: string | null }) {
  const q = useQuery({
    queryKey: ["merchant", "forecast-product", runId, productId],
    queryFn: () => api.get<ProductSeries>(`/merchant/forecasts/${runId}/products/${productId}`),
  });
  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data!;
  const model = s.summary.model_used;
  const rain = s.summary.drivers.find((d) => d.driver === "rain");
  const backtests = s.summary.drivers.find((d) => d.driver === "model")?.backtests ?? {};
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s.summary.stockout_risk} />
        <Badge variant="outline">{MODEL_LABEL[model] ?? model}</Badge>
        <Provenance kind={model === "weather_ridge" ? "ml" : "statistical"} detail={modelDetail(model)} />
        {weatherSource === "simulated" && <Provenance kind="simulated" detail="Precipitation values come from the weather simulator." />}
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Mini label="Stock" value={formatNumber(summary?.current_stock)} />
        <Mini label="Days of cover" value={summary?.days_of_cover?.toFixed(1) ?? "—"} />
        <Mini label="Stockout" value={summary?.stockout_date ? formatDate(summary.stockout_date) : "None in horizon"} />
        <Mini label="Reorder qty" value={formatNumber(s.summary.recommended_reorder_qty)} />
      </div>
      <section>
        <h3 className="mb-1 text-sm font-semibold">Observed sales vs forecast</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Solid line: observed daily units (actuals). Dashed line and band: forecast mean and ~80% interval. They are separate series and never mixed.
        </p>
        {!s.actual.length && !s.forecast.length ? <EmptyState title="No series data" /> : <ForecastChart series={s} />}
      </section>
      <Callout title="Why this forecast">{s.summary.explanation}</Callout>
      {rain?.evidence && (
        <Callout tone="warning" title="Weather association (not causal)">
          On {rain.evidence.rain_days} rainy days this product averaged {rain.evidence.mean_rain}/day vs {rain.evidence.mean_dry}/day on {rain.evidence.dry_days} dry days
          {rain.evidence.ratio ? ` (×${rain.evidence.ratio})` : ""}. {rain.forecast_rain_days} rainy day(s) are in the {rain.weather_source ?? ""} weather forecast.
          This is a historical association, not proof that rain causes the change.
        </Callout>
      )}
      {Object.keys(backtests).length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Backtest ({Object.keys(backtests).length} model{Object.keys(backtests).length === 1 ? "" : "s"})</h3>
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH className="text-right">MAE</TH>
                <TH className="text-right">RMSE</TH>
                <TH className="text-right">WAPE</TH>
              </TR>
            </THead>
            <TBody>
              {Object.entries(backtests).map(([k, v]) => (
                <TR key={k} data-selected={k === model}>
                  <TD>{MODEL_LABEL[k] ?? k}{k === model && <Badge variant="primary" className="ml-2">Selected</Badge>}</TD>
                  <TD className="tabular text-right">{v.mae.toFixed(3)}</TD>
                  <TD className="tabular text-right">{v.rmse.toFixed(3)}</TD>
                  <TD className="tabular text-right">{v.wape == null ? "—" : `${(v.wape * 100).toFixed(1)}%`}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      )}
      <KeyValue items={[["Product ID", <span className="font-mono text-xs">{s.product_id}</span>], ["Observed days shown", s.actual.length], ["Forecast days", s.forecast.length]]} />
    </div>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular font-semibold">{value}</p>
    </div>
  );
}
