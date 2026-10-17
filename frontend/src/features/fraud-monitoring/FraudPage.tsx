/** Fraud monitoring: review queue, case drawer, evaluation, rule configuration and simulated ingestion. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, FlaskConical, ListChecks, Radar, ScanSearch, SlidersHorizontal } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Select } from "@/components/ui/input";
import { KeyValue, PageHeader, Pagination, Provenance, StatCard } from "@/components/ui/data";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/auth-context";
import { useJob } from "@/hooks/use-job";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { cn, formatDateTime, timeAgo, titleCase } from "@/lib/utils";
import type { Page } from "@/types/api";

import { AlertDrawer } from "./AlertDrawer";
import { RulesTab } from "./RulesTab";
import { SimulateTab } from "./SimulateTab";
import type { Evaluation, FraudAlert } from "./types";

const PAGE_SIZE = 20;

export default function FraudPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const alertId = params.get("alert");
  const [tab, setTab] = React.useState("queue");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const setAlert = (id: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set("alert", id);
      else n.delete("alert");
      return n;
    });

  const scan = useMutation({
    mutationFn: () => api.post<{ job_id: string }>("/merchant/fraud/scan", undefined, { days: 30 }),
    onSuccess: (r) => {
      setJobId(r.job_id);
      toast.info("Scanning the last 30 days of transactions…");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const job = useJob(jobId);
  React.useEffect(() => {
    const d = job.data;
    if (!jobId || !d || !["succeeded", "failed"].includes(d.status)) return;
    if (d.status === "succeeded") {
      const r = d.result as { transactions_scored?: number; alerts_created?: number; alerts_updated?: number } | null;
      toast.success(`Scan complete: ${r?.transactions_scored ?? 0} transactions scored, ${r?.alerts_created ?? 0} new alert(s), ${r?.alerts_updated ?? 0} updated`);
    } else toast.error(`Scan failed: ${d.error ?? "unknown error"}`);
    void qc.invalidateQueries({ queryKey: ["merchant", "fraud-alerts"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "fraud-eval"] });
    setJobId(null);
  }, [job.data, jobId, qc]);

  return (
    <>
      <PageHeader
        eyebrow="Loss prevention"
        title="Fraud monitoring"
        description="Rules and anomaly scores prioritise transactions for human review across POS, self-checkout, returns and inventory adjustments."
        actions={
          can("fraud.investigate") && (
            <Button variant="outline" onClick={() => scan.mutate()} loading={scan.isPending || !!jobId}>
              <ScanSearch /> {jobId ? "Scanning…" : "Run scan (30 days)"}
            </Button>
          )
        }
      />
      <Callout title="Review, don’t accuse" className="mb-4">
        Alerts queue cases for staff review. Nothing here blocks a customer, rejects a return or bans an account. Scores use
        transaction behaviour only. No demographic attributes are used.
      </Callout>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="queue"><ListChecks /> Review queue</TabsTrigger>
          <TabsTrigger value="evaluation"><BarChart3 /> Evaluation</TabsTrigger>
          <TabsTrigger value="rules"><SlidersHorizontal /> Rules</TabsTrigger>
          {can("fraud.investigate") && <TabsTrigger value="simulate"><FlaskConical /> Simulate transaction</TabsTrigger>}
        </TabsList>
        <TabsContent value="queue"><QueueTab onOpen={setAlert} /></TabsContent>
        <TabsContent value="evaluation"><EvaluationTab /></TabsContent>
        <TabsContent value="rules"><RulesTab /></TabsContent>
        <TabsContent value="simulate"><SimulateTab onOpenAlert={(id) => { setTab("queue"); setAlert(id); }} /></TabsContent>
      </Tabs>
      <AlertDrawer alertId={alertId} onOpenChange={(o) => !o && setAlert(null)} />
    </>
  );
}

function RiskBar({ score, level }: { score: number; level: string }) {
  const color = level === "high" ? "bg-danger" : level === "medium" ? "bg-warning" : "bg-info";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label={`Risk score ${score.toFixed(0)}`}>
        <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="tabular w-8 text-right text-sm font-semibold">{score.toFixed(0)}</span>
    </div>
  );
}

function QueueTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { storeId, stores } = useMerchantStore();
  const [status, setStatus] = React.useState("open,in_review,escalated");
  const [risk, setRisk] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [status, risk, subject, storeId]);
  const q = useQuery({
    queryKey: ["merchant", "fraud-alerts", storeId, status, risk, subject, page],
    queryFn: () => api.get<Page<FraudAlert>>("/merchant/fraud/alerts", { status: status || undefined, risk_level: risk || undefined, subject_type: subject || undefined, store_id: storeId ?? undefined, page, page_size: PAGE_SIZE }),
    placeholderData: (p) => p,
  });
  const storeCode = (id: string | null) => (id ? stores.find((s) => s.id === id)?.code ?? "—" : "—");
  // The alerts endpoint is merchant-wide; apply the header store filter client-side on the current page.
  const items = q.data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>Review queue</CardTitle>
          <CardDescription>
            Highest risk first. Open a case to review evidence and record an outcome.

          </CardDescription>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <FilterSelect id="f-status" label="Status" value={status} onChange={setStatus} options={[["open,in_review,escalated", "Needs review"], ["open", "Open"], ["in_review", "In review"], ["escalated", "Escalated"], ["closed", "Closed"], ["", "All"]]} />
          <FilterSelect id="f-risk" label="Risk" value={risk} onChange={setRisk} options={[["", "All"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]} />
          <FilterSelect id="f-subject" label="Subject" value={subject} onChange={setSubject} options={[["", "All"], ["transaction", "Transactions"], ["inventory", "Inventory"]]} />
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {q.isLoading ? (
          <SkeletonRows className="px-5" rows={6} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} className="mx-5" />
        ) : !items.length ? (
          <EmptyState icon={Radar} title="No alerts match these filters" description="Run a scan or simulate a transaction to generate alerts." className="mx-5 mb-5" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Risk</TH>
                <TH>Level</TH>
                <TH>Subject</TH>
                <TH>Summary</TH>
                <TH className="text-right">Signals</TH>
                <TH>Status</TH>
                <TH>Detected</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((a) => (
                <TR key={a.id} className="cursor-pointer" onClick={() => onOpen(a.id)}>
                  <TD><RiskBar score={a.risk_score} level={a.risk_level} /></TD>
                  <TD><StatusBadge status={a.risk_level} /></TD>
                  <TD>
                    <button type="button" className="text-left hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(a.id); }} aria-label={`Open case ${a.subject_ref}`}>
                      <span className="block font-mono text-xs font-medium">{a.subject_ref}</span>
                    </button>
                    <span className="block text-xs text-muted-foreground">{titleCase(a.subject_type)} · {storeCode(a.store_id)}</span>
                  </TD>
                  <TD className="max-w-sm"><span className="line-clamp-2 text-sm">{a.summary}</span></TD>
                  <TD className="tabular text-right">{a.signals.length}</TD>
                  <TD>
                    <span className="flex flex-col items-start gap-1">
                      <StatusBadge status={a.status} />
                      {a.outcome && <StatusBadge status={a.outcome} />}
                    </span>
                  </TD>
                  <TD className="whitespace-nowrap text-xs" title={formatDateTime(a.detected_at)}>{timeAgo(a.detected_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {q.data && q.data.total > 0 && (
          <div className="px-4">
            <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FilterSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-36 text-sm">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </div>
  );
}

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function EvaluationTab() {
  const q = useQuery({ queryKey: ["merchant", "fraud-eval"], queryFn: () => api.get<Evaluation>("/merchant/fraud/evaluation") });
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const e = q.data!;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Precision" value={pct(e.precision)} hint="Flagged transactions that are labelled fraud" tone="success" />
        <StatCard label="Recall" value={pct(e.recall)} hint="Labelled fraud that was flagged" tone="success" />
        <StatCard label="Reviewed alerts" value={e.reviewed_alerts} hint={`of ${e.alerts} transaction alerts`} />
        <StatCard label="Reviewer confirmed rate" value={pct(e.reviewer_confirmed_rate)} hint="Closed as confirmed fraud" />
      </div>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Confusion counts</CardTitle>
            <CardDescription>Transaction alerts compared with ground-truth labels.</CardDescription>
          </div>
          {e.label_source === "synthetic" ? <Provenance kind="demo" detail="Labels are synthetic and were generated with the demo data." /> : <Badge>{e.label_source ?? "No labels"}</Badge>}
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Cell label="True positives" value={e.true_positives} tone="success" />
            <Cell label="False positives" value={e.false_positives} tone="warning" />
            <Cell label="False negatives" value={e.false_negatives} tone="danger" />
          </div>
          <KeyValue items={[["Labelled transactions", e.labelled_transactions], ["Transaction alerts", e.alerts], ["Label source", e.label_source ?? "—"]]} />
          <p className="text-sm text-muted-foreground md:col-span-2">{e.note}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: number; tone: "success" | "warning" | "danger" }) {
  const cls = { success: "bg-success-soft text-success", warning: "bg-warning-soft text-warning", danger: "bg-danger-soft text-danger" }[tone];
  return (
    <div className={cn("rounded-md p-3", cls)}>
      <p className="tabular text-2xl font-semibold">{value}</p>
      <p className="text-xs text-foreground/80">{label}</p>
    </div>
  );
}
