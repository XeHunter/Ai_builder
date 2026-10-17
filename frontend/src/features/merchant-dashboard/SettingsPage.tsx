import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw, Search } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue, PageHeader, Pagination } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-context";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { cn, formatDateTime, titleCase } from "@/lib/utils";
import type { JobOut, Page } from "@/types/api";

import { JsonBlock, summarizeResult, useDebouncedValue } from "./components/common";
import type { AuditEvent } from "./types";

const TABS = ["audit", "jobs", "account"] as const;

export default function SettingsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const canAudit = can("audit.read");
  const tab = requested && (TABS as readonly string[]).includes(requested) ? requested : canAudit ? "audit" : "jobs";
  return (
    <div>
      <PageHeader eyebrow="Administration" title="Settings & audit" description="Every change is recorded in the audit log. Background jobs run scheduled analytics and can be triggered manually." />
      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
          <TabsTrigger value="jobs">Background jobs</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>
        <TabsContent value="audit">{canAudit ? <AuditTab /> : <Callout>Viewing the audit log requires the audit.read permission.</Callout>}</TabsContent>
        <TabsContent value="jobs">
          <JobsTab />
        </TabsContent>
        <TabsContent value="account">
          <AccountTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const ENTITY_TYPES = ["price_change", "promotion", "product", "inventory_item", "import_job", "expiry_alert", "store_task", "pricing_rule", "merchant_settings", "integration_config", "store", "user"];
const PAGE_SIZE = 25;

function AuditTab() {
  const [entityType, setEntityType] = React.useState("");
  const [actionText, setActionText] = React.useState("");
  const [entityText, setEntityText] = React.useState("");
  const action = useDebouncedValue(actionText.trim(), 300);
  const entityId = useDebouncedValue(entityText.trim(), 300);
  const [page, setPage] = React.useState(1);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  React.useEffect(() => setPage(1), [entityType, action, entityId]);
  const q = useQuery({
    queryKey: ["merchant", "audit", entityType, action, entityId, page],
    queryFn: () => api.get<Page<AuditEvent>>("/merchant/audit-events", { entity_type: entityType, action, entity_id: entityId, page, page_size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <div className="flex flex-col gap-2 border-b border-border p-3 md:flex-row">
        <Select aria-label="Entity type" value={entityType} onChange={(e) => setEntityType(e.target.value)} className="md:w-56">
          <option value="">All entity types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {titleCase(t)}
            </option>
          ))}
        </Select>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Action prefix" placeholder="Action starts with, e.g. pricing.price_change" className="pl-8" value={actionText} maxLength={64} onChange={(e) => setActionText(e.target.value)} />
        </div>
        <Input aria-label="Entity id" placeholder="Entity id" className="md:w-72" value={entityText} onChange={(e) => setEntityText(e.target.value)} />
      </div>
      {q.isLoading ? (
        <SkeletonRows rows={8} className="p-3" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-3" />
      ) : !q.data?.items.length ? (
        <EmptyState className="m-3" title="No audit events match" />
      ) : (
        <>
          <Table className={cn(q.isPlaceholderData && "opacity-60")}>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Summary</TH>
                <TH className="sr-only">Details</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((ev) => {
                const open = expanded === ev.id;
                const hasDiff = ev.before !== null || ev.after !== null;
                return (
                  <React.Fragment key={ev.id}>
                    <TR>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(ev.created_at)}</TD>
                      <TD className="max-w-48 truncate text-xs" title={ev.actor ?? undefined}>
                        {ev.actor ?? "system"}
                      </TD>
                      <TD className="font-mono text-xs">{ev.action}</TD>
                      <TD className="text-xs">
                        <div>{titleCase(ev.entity_type)}</div>
                        {ev.entity_id && (
                          <button type="button" className="font-mono text-muted-foreground hover:text-primary hover:underline" onClick={() => setEntityText(ev.entity_id ?? "")} title="Filter by this entity">
                            {ev.entity_id.slice(0, 8)}…
                          </button>
                        )}
                      </TD>
                      <TD className="text-sm">{ev.summary}</TD>
                      <TD className="text-right">
                        {hasDiff && (
                          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setExpanded(open ? null : ev.id)}>
                            {open ? "Hide" : "Before / after"}
                          </Button>
                        )}
                      </TD>
                    </TR>
                    {open && (
                      <tr>
                        <td colSpan={6} className="bg-surface-raised px-3 py-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <p className="mb-1 text-xs font-medium text-muted-foreground">Before</p>
                              <JsonBlock value={ev.before} />
                            </div>
                            <div>
                              <p className="mb-1 text-xs font-medium text-muted-foreground">After</p>
                              <JsonBlock value={ev.after} />
                            </div>
                          </div>
                          {ev.request_id && <p className="mt-2 text-xs text-muted-foreground">Request id {ev.request_id}</p>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
          <div className="border-t border-border px-3">
            <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />
          </div>
        </>
      )}
    </Card>
  );
}

const JOB_TYPES: { value: string; label: string; description: string }[] = [
  { value: "expiry_reevaluation", label: "Expiry re-evaluation", description: "Alerts, markdown recommendations and withdrawal of expired stock" },
  { value: "forecast_refresh", label: "Forecast refresh", description: "Retrain demand forecasts" },
  { value: "stockout_risk_refresh", label: "Stockout risk refresh", description: "Recompute stockout risk from the latest forecast" },
  { value: "promotion_lifecycle", label: "Promotion lifecycle", description: "Start scheduled and end finished promotions" },
  { value: "analytics_refresh", label: "Analytics refresh", description: "Recompute affinity and dashboard aggregates" },
  { value: "fraud_scan", label: "Fraud scan", description: "Score recent transactions for fraud signals" },
  { value: "embedding_reindex", label: "Search reindex", description: "Rebuild product search embeddings" },
];

function duration(j: JobOut): string {
  if (!j.started_at || !j.finished_at) return "—";
  const s = (new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000;
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`;
}

function JobsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canRun = can("settings.manage");
  const [jobType, setJobType] = React.useState(JOB_TYPES[0].value);
  const q = useQuery({
    queryKey: ["merchant", "jobs"],
    queryFn: () => api.get<JobOut[]>("/merchant/jobs", { limit: 50 }),
    refetchInterval: (query) => (query.state.data?.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false),
  });
  const trigger = useMutation({
    mutationFn: (t: string) => api.post<JobOut>("/merchant/jobs", { job_type: t }),
    onSuccess: (j) => {
      toast.success(`${titleCase(j.job_type)} queued`);
      void qc.invalidateQueries({ queryKey: ["merchant", "jobs"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const running = q.data?.some((j) => j.status === "queued" || j.status === "running");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Run a job</CardTitle>
          <CardDescription>{canRun ? "Jobs run in the background worker; results appear below." : "Triggering jobs requires the settings.manage permission."}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select aria-label="Job type" value={jobType} onChange={(e) => setJobType(e.target.value)} disabled={!canRun} className="sm:w-72">
            {JOB_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <Button onClick={() => trigger.mutate(jobType)} disabled={!canRun} loading={trigger.isPending}>
            <Play /> Run now
          </Button>
          <p className="text-xs text-muted-foreground sm:ml-2">{JOB_TYPES.find((t) => t.value === jobType)?.description}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Recent jobs</CardTitle>
            <CardDescription>{running ? "Refreshing automatically while jobs are running." : "Latest 50 runs."}</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => q.refetch()} loading={q.isFetching && !q.isLoading}>
            <RefreshCw /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="px-0">
          {q.isLoading ? (
            <SkeletonRows rows={6} className="px-5" />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} className="mx-5" />
          ) : !q.data?.length ? (
            <EmptyState className="mx-5" title="No jobs have run yet" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Type</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Attempts</TH>
                  <TH>Created</TH>
                  <TH>Finished</TH>
                  <TH className="text-right">Duration</TH>
                  <TH>Result / error</TH>
                </TR>
              </THead>
              <TBody>
                {q.data.map((j) => (
                  <TR key={j.id}>
                    <TD className="font-medium">{titleCase(j.job_type)}</TD>
                    <TD>
                      <StatusBadge status={j.status} />
                    </TD>
                    <TD className="tabular text-right">
                      {j.attempts}/{j.max_attempts}
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(j.created_at)}</TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(j.finished_at)}</TD>
                    <TD className="tabular text-right text-xs">{duration(j)}</TD>
                    <TD className="max-w-md text-xs">{j.error ? <span className="text-danger">{j.error}</span> : <span className="text-muted-foreground">{summarizeResult(j.result) || "—"}</span>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AccountTab() {
  const { me } = useAuth();
  const { stores } = useMerchantStore();
  if (!me) return null;
  const m = me.merchant;
  const groups = new Map<string, string[]>();
  for (const p of m?.permissions ?? []) {
    const [area, verb] = p.split(".");
    groups.set(area, [...(groups.get(area) ?? []), verb ?? p]);
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Signed in as</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValue
            items={[
              ["Name", me.user.full_name],
              ["Email", me.user.email],
              ["Merchant", m?.merchant_name ?? "—"],
              ["Role", m ? titleCase(m.role) : "—"],
              ["Store access", m?.all_stores ? "All stores" : stores.map((s) => s.code).join(", ") || "None"],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>Granted by your role. Actions you lack permission for are hidden or disabled; the server enforces them too.</CardDescription>
        </CardHeader>
        <CardContent>
          {groups.size === 0 ? (
            <p className="text-sm text-muted-foreground">No merchant permissions.</p>
          ) : (
            <dl className="space-y-2">
              {[...groups.entries()].map(([area, verbs]) => (
                <div key={area} className="flex flex-wrap items-center gap-1.5">
                  <dt className="w-32 text-sm font-medium">{titleCase(area)}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {verbs.map((v) => (
                      <Badge key={v} variant="primary">
                        {v}
                      </Badge>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
