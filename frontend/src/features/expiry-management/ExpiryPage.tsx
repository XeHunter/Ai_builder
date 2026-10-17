import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, RefreshCw } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, Provenance } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-context";
import { FilterChips, JobStatus } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, hoursLabel, titleCase } from "@/lib/utils";
import type { JobOut } from "@/types/api";

import type { ExpiryAlert, ExpiryBatch, StoreEvaluation, StoreTask } from "./types";

type Tab = "batches" | "alerts" | "tasks";

function useInvalidateExpiry() {
  const qc = useQueryClient();
  return React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["merchant", "expiry"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "pricing"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "inventory"] });
  }, [qc]);
}

export default function ExpiryPage() {
  const [params, setParams] = useSearchParams();
  const tab = (["batches", "alerts", "tasks"].includes(params.get("tab") ?? "") ? params.get("tab") : "batches") as Tab;
  const setTab = (t: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Fresh & perishables"
        title="Expiry management"
        description="Batches approaching their sell-by limit, prioritised by value at risk, with markdown recommendations, alerts and staff tasks."
        actions={<EvaluateButton />}
      />
      <Callout className="mb-4" title="How markdowns are recommended">
        <span className="mr-1 inline-flex align-middle">
          <Provenance kind="heuristic" />
        </span>
        Expected sell-through uses each product's 14-day sales velocity. When stock is likely to remain at the sell-by limit, a heuristic markdown ladder (configurable tiers and an assumed price elasticity,
        not a learned model) proposes a discount capped by policy and the price floor. Recommendations need approval unless auto-publish is enabled in policy. Expired stock is withdrawn and never sold.
      </Callout>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="batches">Upcoming batches</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="tasks">Store tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="batches">
          <BatchesTab />
        </TabsContent>
        <TabsContent value="alerts">
          <AlertsTab />
        </TabsContent>
        <TabsContent value="tasks">
          <TasksTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EvaluateButton() {
  const { can } = useAuth();
  const { storeId, stores } = useMerchantStore();
  const invalidate = useInvalidateExpiry();
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<StoreEvaluation | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<StoreEvaluation | { job_id: string; status: string }>("/merchant/expiry/evaluate", undefined, { store_id: storeId }),
    onSuccess: (r) => {
      if ("job_id" in r) {
        setJobId(r.job_id);
        setResult(null);
        toast.message("Re-evaluation queued for all stores");
      } else {
        setResult(r);
        setJobId(null);
        invalidate();
        toast.success(`Evaluated ${r.batches_evaluated} batches at ${r.store}`);
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const onDone = React.useCallback(
    (j: JobOut) => {
      invalidate();
      if (j.status === "succeeded") toast.success("Expiry re-evaluation finished");
      else toast.error("Expiry re-evaluation failed");
    },
    [invalidate],
  );
  if (!can("expiry.manage")) return null;
  const storeName = storeId ? stores.find((s) => s.id === storeId)?.code : null;
  const changes = result?.results.filter((r) => r.price_change_id || r.actions.some((a) => a !== "no markdown needed")) ?? [];
  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={() => m.mutate()} loading={m.isPending}>
        <RefreshCw /> Re-evaluate {storeName ? storeName : "all stores"} now
      </Button>
      {jobId && <JobStatus jobId={jobId} label="Expiry re-evaluation" onDone={onDone} />}
      {result && (
        <div className="w-full max-w-md rounded-md border border-border bg-surface p-3 text-sm" role="status">
          <p className="font-medium">
            {result.store}: {result.batches_evaluated} batches evaluated, {result.price_changes_expired} finished markdowns expired
          </p>
          {changes.length > 0 ? (
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-xs text-muted-foreground">
              {changes.map((c) => (
                <li key={c.batch_id}>
                  <span className="text-foreground">{c.product}</span> ({hoursLabel(c.hours_left)}): {c.actions.join(", ") || "no action"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No new actions were needed.</p>
          )}
          <Button variant="link" size="sm" className="h-auto" onClick={() => setResult(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function BatchesTab() {
  const { storeId } = useMerchantStore();
  const [days, setDays] = React.useState(7);
  const q = useQuery({
    queryKey: ["merchant", "expiry", "batches", storeId, days],
    queryFn: () => api.get<ExpiryBatch[]>("/merchant/expiry/batches", { store_id: storeId, days }),
  });
  const totalValue = (q.data ?? []).reduce((s, b) => s + b.value_at_risk, 0);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Batches expiring soon</CardTitle>
          {q.data && (
            <p className="mt-1 text-sm text-muted-foreground">
              {q.data.length} batches · {formatCurrency(totalValue, { whole: true })} cost value at risk if unsold
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="exp-days" className="text-sm text-muted-foreground">
            Expiring within
          </label>
          <Select id="exp-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-32">
            {[1, 3, 7, 14, 30].map((d) => (
              <option key={d} value={d}>
                {d} day{d > 1 ? "s" : ""}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {q.isLoading ? (
          <SkeletonRows rows={6} className="px-5" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="mx-5" />
        ) : !q.data?.length ? (
          <EmptyState className="mx-5" title="No batches expiring in this window" description="Try a longer window, or import batches with expiry dates." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH>Batch</TH>
                <TH>Store</TH>
                <TH>Expiry</TH>
                <TH className="text-right">To sell-by</TH>
                <TH className="text-right">Remaining</TH>
                <TH className="text-right">Velocity (14d)</TH>
                <TH className="text-right">Expected sell-through</TH>
                <TH className="text-right">Units at risk</TH>
                <TH className="text-right">Value at risk</TH>
                <TH>Status</TH>
                <TH>Price change</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.map((b) => (
                <TR key={b.batch_id}>
                  <TD>
                    <div className="font-medium">{b.product}</div>
                    <div className="font-mono text-xs text-muted-foreground">{b.sku}</div>
                  </TD>
                  <TD className="font-mono text-xs">{b.batch_code}</TD>
                  <TD>
                    <Badge variant="outline">{b.store_code}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap">{formatDate(b.expiry_date)}</TD>
                  <TD className={cn("tabular text-right font-medium", b.hours_to_sell_by < 48 && "text-danger")}>{hoursLabel(b.hours_to_sell_by)}</TD>
                  <TD className="tabular text-right">{formatNumber(b.quantity_remaining)}</TD>
                  <TD className="tabular text-right text-muted-foreground">{formatNumber(b.daily_velocity, 2)}/day</TD>
                  <TD className="tabular text-right">{formatNumber(b.expected_sell_through, 1)}</TD>
                  <TD className={cn("tabular text-right", b.units_at_risk > 0 && "font-medium text-warning")}>{formatNumber(b.units_at_risk, 1)}</TD>
                  <TD className="tabular text-right">{formatCurrency(b.value_at_risk)}</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge status={b.status} />
                      {b.in_clearance && <Badge variant="accent">Clearance</Badge>}
                      {b.markdown_price !== null && <Badge variant="success">Now {formatCurrency(b.markdown_price)}</Badge>}
                    </div>
                  </TD>
                  <TD>
                    {b.price_change ? (
                      <Link to={`/merchant/pricing?change=${b.price_change.id}`} className="inline-flex items-center gap-1.5 text-xs hover:underline">
                        <StatusBadge status={b.price_change.status} />
                        <span className="tabular">
                          −{b.price_change.discount_pct}% → {formatCurrency(b.price_change.proposed_price)}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const ALERT_FILTERS = [
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "", label: "All" },
] as const;

function AlertsTab() {
  const { storeId } = useMerchantStore();
  const { can } = useAuth();
  const invalidate = useInvalidateExpiry();
  const [status, setStatus] = React.useState<string>("open");
  const q = useQuery({
    queryKey: ["merchant", "expiry", "alerts", storeId, status],
    queryFn: () => api.get<ExpiryAlert[]>("/merchant/expiry/alerts", { store_id: storeId, status }),
  });
  const m = useMutation({
    mutationFn: ({ id, to }: { id: string; to: "acknowledged" | "resolved" }) => api.patch<{ id: string; status: string }>(`/merchant/expiry/alerts/${id}`, { status: to }),
    onSuccess: (r) => {
      toast.success(`Alert ${r.status}`);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canManage = can("expiry.manage");
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>Expiry alerts</CardTitle>
        <FilterChips label="Alert status" options={ALERT_FILTERS as unknown as { value: string; label: string }[]} value={status} onChange={setStatus} />
      </CardHeader>
      <CardContent className="px-0">
        {q.isLoading ? (
          <SkeletonRows rows={5} className="px-5" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="mx-5" />
        ) : !q.data?.length ? (
          <EmptyState className="mx-5" icon={CheckCircle2} title="No alerts" description="Alerts are raised by expiry evaluation when batches enter the warning or critical window." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Severity</TH>
                <TH>Alert</TH>
                <TH className="text-right">Hours left</TH>
                <TH className="text-right">Qty at alert</TH>
                <TH>Status</TH>
                <TH>Raised</TH>
                {canManage && <TH className="text-right">Actions</TH>}
              </TR>
            </THead>
            <TBody>
              {q.data.map((a) => {
                const pending = m.isPending && m.variables?.id === a.id;
                return (
                  <TR key={a.id}>
                    <TD>
                      <StatusBadge status={a.severity} />
                    </TD>
                    <TD>
                      <div className="font-medium">{a.product}</div>
                      <div className="text-xs text-muted-foreground">{a.message}</div>
                    </TD>
                    <TD className="tabular text-right">{a.hours_to_expiry}</TD>
                    <TD className="tabular text-right">{a.quantity_at_alert}</TD>
                    <TD>
                      <StatusBadge status={a.status} />
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(a.created_at)}</TD>
                    {canManage && (
                      <TD className="whitespace-nowrap text-right">
                        {a.status === "open" && (
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => m.mutate({ id: a.id, to: "acknowledged" })}>
                            Acknowledge
                          </Button>
                        )}
                        {a.status !== "resolved" && (
                          <Button size="sm" variant="ghost" className="ml-1" disabled={pending} onClick={() => m.mutate({ id: a.id, to: "resolved" })}>
                            Resolve
                          </Button>
                        )}
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TasksTab() {
  const { storeId, stores } = useMerchantStore();
  const { can } = useAuth();
  const invalidate = useInvalidateExpiry();
  const [status, setStatus] = React.useState<"open" | "done">("open");
  const q = useQuery({
    queryKey: ["merchant", "expiry", "tasks", storeId, status],
    queryFn: () => api.get<StoreTask[]>("/merchant/expiry/tasks", { store_id: storeId, status }),
  });
  const m = useMutation({
    mutationFn: (id: string) => api.post<{ id: string; status: string }>(`/merchant/expiry/tasks/${id}/complete`),
    onSuccess: () => {
      toast.success("Task marked done");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const code = (id: string) => stores.find((s) => s.id === id)?.code ?? "—";
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Store tasks</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Clearance-bin moves, shelf relabels and expired-stock removal generated by markdowns and evaluations.</p>
        </div>
        <FilterChips
          label="Task status"
          options={[
            { value: "open", label: "Open" },
            { value: "done", label: "Done" },
          ]}
          value={status}
          onChange={setStatus}
        />
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <SkeletonRows rows={4} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState icon={ClipboardCheck} title={status === "open" ? "No open tasks" : "No completed tasks yet"} />
        ) : (
          <ul className="space-y-2">
            {q.data.map((t) => (
              <li key={t.id} className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={t.task_type === "remove_expired" ? "danger" : t.task_type.includes("clearance") ? "accent" : "info"}>{titleCase(t.task_type)}</Badge>
                    <Badge variant="outline">{code(t.store_id)}</Badge>
                    <span className="font-medium">{t.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-foreground/85">{t.instruction}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Created {formatDateTime(t.created_at)}
                    {t.completed_at ? ` · done ${formatDateTime(t.completed_at)}` : ""}
                  </p>
                </div>
                {t.status === "open" && can("inventory.write") && (
                  <Button size="sm" variant="outline" onClick={() => m.mutate(t.id)} loading={m.isPending && m.variables === t.id}>
                    <CheckCircle2 /> Mark done
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
