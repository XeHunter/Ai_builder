/** Cross-selling: market-basket association rules, category heatmap and product network. */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, ArrowUp, Network, Plus, ShoppingBasket } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, EmptyState, ErrorState, Progress, Skeleton, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader, Provenance, StatCard } from "@/components/ui/data";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-context";
import { useJob } from "@/hooks/use-job";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";

import { AffinityNetwork } from "./AffinityNetwork";
import { CategoryHeatmap } from "./CategoryHeatmap";
import type { AffinityGraph, AffinityRule, AffinityRun, AffinityRunDetail, Heatmap } from "./types";

export const runSchema = z.object({
  store_id: z.string(),
  window_days: z.number({ message: "Enter a number" }).int().min(7, "At least 7 days").max(365, "At most 365 days"),
  min_support: z.number({ message: "Enter a number" }).gt(0, "Must be above 0").max(0.5, "At most 0.5"),
  min_confidence: z.number({ message: "Enter a number" }).min(0, "At least 0").max(1, "At most 1"),
  min_pair_count: z.number({ message: "Enter a number" }).int().min(5, "At least 5").max(10000, "At most 10,000"),
});
type RunForm = z.infer<typeof runSchema>;

export default function CrossSellingPage() {
  const { can } = useAuth();
  const { stores } = useMerchantStore();
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [pendingRun, setPendingRun] = React.useState<string | null>(null);

  const runs = useQuery({ queryKey: ["merchant", "affinity-runs"], queryFn: () => api.get<AffinityRun[]>("/merchant/affinity/runs") });
  const runId = selected ?? runs.data?.find((r) => r.status === "succeeded")?.id ?? runs.data?.[0]?.id ?? null;
  const storeName = (id: string | null) => (id ? stores.find((s) => s.id === id)?.code ?? "Store" : "All stores");

  const job = useJob(jobId);
  React.useEffect(() => {
    const st = job.data?.status;
    if (!jobId || !st) return;
    if (st === "succeeded" || st === "failed") {
      if (st === "succeeded") toast.success("Affinity analysis finished");
      else toast.error(`Affinity analysis failed: ${job.data?.error ?? "see run details"}`);
      void qc.invalidateQueries({ queryKey: ["merchant", "affinity-runs"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "affinity-run"] });
      if (pendingRun) setSelected(pendingRun);
      setJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.data?.status, jobId]);

  const create = useMutation({
    mutationFn: (v: RunForm) => api.post<AffinityRun>("/merchant/affinity/runs", { ...v, store_id: v.store_id || null }),
    onSuccess: (r) => {
      toast.info("Affinity analysis queued");
      setOpen(false);
      setJobId(r.job_id ?? null);
      setPendingRun(r.id);
      void qc.invalidateQueries({ queryKey: ["merchant", "affinity-runs"] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Cross-selling & product affinity"
        description="Which products are bought together, measured by support, confidence and lift across past baskets."
        actions={
          can("affinity.run") && (
            <Button onClick={() => setOpen(true)} disabled={!!jobId}>
              <Plus /> New analysis
            </Button>
          )
        }
      />
      {jobId && (
        <Card className="mb-4">
          <CardContent className="flex flex-col gap-2 pt-5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Mining association rules…</span>
              <StatusBadge status={job.data?.status ?? "queued"} />
            </div>
            <Progress value={job.data?.status === "running" ? 60 : 20} label="Affinity job progress" />
          </CardContent>
        </Card>
      )}
      <Callout title="How to read lift" className="mb-4">
        Lift &gt; 1 means two products appear in the same basket more often than if they were bought independently; lift
        &lt; 1 means less often. These are co-occurrence patterns in past baskets: correlation, not causation. Use them to
        design tests (see Merchandising), not as proof that one product drives another.
      </Callout>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {runs.isLoading ? (
              <SkeletonRows rows={4} />
            ) : runs.isError ? (
              <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
            ) : !runs.data?.length ? (
              <EmptyState icon={ShoppingBasket} title="No analyses yet" />
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Affinity runs">
                {runs.data.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => setSelected(r.id)} aria-current={r.id === runId}
                      className={cn("w-full rounded-md border px-3 py-2 text-left text-sm", r.id === runId ? "border-primary bg-primary-soft" : "border-transparent hover:bg-muted")}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{storeName(r.store_id)} · {r.window_days} d</span>
                        <StatusBadge status={r.status} />
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(r.created_at)}
                        {r.rules_found != null && ` · ${formatNumber(r.rules_found)} rules`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <div className="min-w-0">{runId ? <RunView runId={runId} storeName={storeName} /> : null}</div>
      </div>
      <NewRunDialog open={open} onOpenChange={setOpen} submitting={create.isPending} onSubmit={(v) => create.mutate(v)} />
    </>
  );
}

function NewRunDialog({ open, onOpenChange, submitting, onSubmit }: { open: boolean; onOpenChange: (o: boolean) => void; submitting: boolean; onSubmit: (v: RunForm) => void }) {
  const { stores, storeId } = useMerchantStore();
  const defaults = React.useMemo(() => ({ store_id: storeId ?? "", window_days: 90, min_support: 0.005, min_confidence: 0.1, min_pair_count: 20 }), [storeId]);
  const form = useForm<RunForm>({ resolver: zodResolver(runSchema), defaultValues: defaults });
  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);
  const e = form.formState.errors;
  const num = { valueAsNumber: true } as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New affinity analysis" description="Mines pairwise association rules from sale baskets in the window. Runs in the background.">
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          <Field label="Scope" htmlFor="af-store">
            <Select id="af-store" {...form.register("store_id")}>
              <option value="">All stores</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Window (days)" htmlFor="af-window" error={e.window_days?.message} hint="7 – 365">
              <Input id="af-window" type="number" aria-invalid={!!e.window_days} {...form.register("window_days", num)} />
            </Field>
            <Field label="Min pair count" htmlFor="af-pairs" error={e.min_pair_count?.message} hint="Baskets containing both products">
              <Input id="af-pairs" type="number" aria-invalid={!!e.min_pair_count} {...form.register("min_pair_count", num)} />
            </Field>
            <Field label="Min support" htmlFor="af-support" error={e.min_support?.message} hint="Share of baskets, e.g. 0.005 = 0.5%">
              <Input id="af-support" type="number" step="0.001" aria-invalid={!!e.min_support} {...form.register("min_support", num)} />
            </Field>
            <Field label="Min confidence" htmlFor="af-conf" error={e.min_confidence?.message} hint="P(B | A), 0 – 1">
              <Input id="af-conf" type="number" step="0.01" aria-invalid={!!e.min_confidence} {...form.register("min_confidence", num)} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={submitting}>Run analysis</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SortKey = "lift" | "confidence" | "support" | "pair_count";

export function sortRules(rules: AffinityRule[], key: SortKey, dir: "asc" | "desc"): AffinityRule[] {
  const m = dir === "asc" ? 1 : -1;
  return [...rules].sort((a, b) => (a[key] - b[key]) * m || a.antecedent.localeCompare(b.antecedent));
}

function RunView({ runId, storeName }: { runId: string; storeName: (id: string | null) => string }) {
  const [minLift, setMinLift] = React.useState(1);
  const [graphLift, setGraphLift] = React.useState(1.5);
  const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "lift", dir: "desc" });
  const q = useQuery({
    queryKey: ["merchant", "affinity-run", runId, minLift],
    queryFn: () => api.get<AffinityRunDetail>(`/merchant/affinity/runs/${runId}`, { min_lift: minLift, limit: 300 }),
    placeholderData: (prev) => (prev?.id === runId ? prev : undefined),
    refetchInterval: (query) => (query.state.data && ["queued", "running"].includes(query.state.data.status) ? 2000 : false),
  });
  const ok = q.data?.status === "succeeded";
  const heat = useQuery({ queryKey: ["merchant", "affinity-heatmap", runId], queryFn: () => api.get<Heatmap>(`/merchant/affinity/runs/${runId}/heatmap`), enabled: ok });
  const graph = useQuery({
    queryKey: ["merchant", "affinity-graph", runId, graphLift],
    queryFn: () => api.get<AffinityGraph>(`/merchant/affinity/runs/${runId}/graph`, { min_lift: graphLift, max_edges: 60 }),
    enabled: ok,
    placeholderData: (prev) => prev,
  });
  const rules = React.useMemo(() => (q.data ? sortRules(q.data.rules, sort.key, sort.dir) : []), [q.data, sort]);

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const run = q.data!;
  if (run.status === "failed") {
    return (
      <Callout tone="warning" title="This analysis failed">
        {run.error ?? "Unknown error."} Try a longer window or lower thresholds if there was not enough basket data.
      </Callout>
    );
  }
  if (!ok) return <EmptyState title={`Analysis ${run.status}`} description="Results appear when the background job finishes." />;

  const sortTh = (k: SortKey, label: string) => {
    const activeSort = sort.key === k;
    return (
      <TH key={k} className="text-right" aria-sort={activeSort ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={() => setSort({ key: k, dir: activeSort && sort.dir === "desc" ? "asc" : "desc" })}>
          {label}
          {activeSort && (sort.dir === "desc" ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />)}
        </button>
      </TH>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Transactions analysed" value={formatNumber(run.transactions_analyzed)} hint={`${storeName(run.store_id)} · last ${run.window_days} days`} />
        <StatCard label="Rules found" value={formatNumber(run.rules_found)} />
        <StatCard label="Thresholds" value={<span className="text-base">{(run.min_support * 100).toFixed(2)}% · {(run.min_confidence * 100).toFixed(0)}%</span>} hint="min support · min confidence" />
        <StatCard label="Min pair count" value={formatNumber(run.min_pair_count)} hint={`Finished ${formatDateTime(run.finished_at)}`} />
      </div>
      <Tabs defaultValue="rules">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="heatmap">Category heatmap</TabsTrigger>
            <TabsTrigger value="graph"><Network /> Product network</TabsTrigger>
          </TabsList>
          <Provenance kind="statistical" detail="Pairwise association rules (support, confidence, lift) computed from your sale transactions." />
        </div>
        <TabsContent value="rules">
          <Card>
            <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
              <div>
                <CardTitle>Association rules</CardTitle>
                <CardDescription>“A → B”: share of baskets with A that also contain B (confidence), and how much more often than chance (lift).</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="min-lift" className="text-sm font-medium">Min lift</label>
                <Select id="min-lift" value={String(minLift)} onChange={(e) => setMinLift(Number(e.target.value))} className="w-28">
                  {[0, 1, 1.5, 2, 3, 5].map((v) => <option key={v} value={v}>{v === 0 ? "Any" : `≥ ${v}`}</option>)}
                </Select>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              {!rules.length ? (
                <EmptyState title="No rules at this lift" className="mx-5" />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Rule</TH>
                      {sortTh("pair_count", "Pairs")}
                      {sortTh("support", "Support")}
                      {sortTh("confidence", "Confidence")}
                      {sortTh("lift", "Lift")}
                    </TR>
                  </THead>
                  <TBody>
                    {rules.map((r) => (
                      <TR key={`${r.antecedent_id}-${r.consequent_id}`}>
                        <TD>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium">{r.antecedent}</span>
                            <ArrowRight className="size-3.5 text-muted-foreground" aria-label="then" />
                            <span>{r.consequent}</span>
                          </span>
                        </TD>
                        <TD className="tabular text-right">{formatNumber(r.pair_count)}</TD>
                        <TD className="tabular text-right">{(r.support * 100).toFixed(2)}%</TD>
                        <TD className="tabular text-right">{(r.confidence * 100).toFixed(1)}%</TD>
                        <TD className={cn("tabular text-right font-semibold", r.lift >= 2 ? "text-primary" : r.lift < 1 ? "text-warning" : undefined)}>{r.lift.toFixed(2)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
              <p className="px-5 pt-3 text-xs text-muted-foreground">{run.interpretation} Showing up to 300 rules.</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="heatmap">
          <Card>
            <CardHeader>
              <CardTitle>Category affinity</CardTitle>
              <CardDescription>Lift between categories (symmetric). Empty cells had too few co-purchases to estimate.</CardDescription>
            </CardHeader>
            <CardContent>
              {heat.isLoading ? <Skeleton className="h-80 w-full" /> : heat.isError ? <ErrorState error={heat.error} onRetry={() => void heat.refetch()} /> : !heat.data?.categories.length ? <EmptyState title="No category data" /> : <CategoryHeatmap data={heat.data} />}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="graph">
          <Card>
            <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
              <div>
                <CardTitle>Product network</CardTitle>
                <CardDescription>Strongest 60 product pairs. Colour = category; line width = lift; node size = number of links.</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="graph-lift" className="text-sm font-medium">Min lift</label>
                <Select id="graph-lift" value={String(graphLift)} onChange={(e) => setGraphLift(Number(e.target.value))} className="w-28">
                  {[1, 1.5, 2, 3, 5].map((v) => <option key={v} value={v}>≥ {v}</option>)}
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {graph.isLoading ? <Skeleton className="h-96 w-full" /> : graph.isError ? <ErrorState error={graph.error} onRetry={() => void graph.refetch()} /> : !graph.data?.nodes.length ? <EmptyState title="No pairs above this lift" /> : <AffinityNetwork graph={graph.data} />}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
