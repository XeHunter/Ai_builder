/** Fraud alert case view: score breakdown, signals, receipts side by side, history, notes and review actions. */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CircleCheck, MessageSquarePlus, PlayCircle, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Field, Select, Textarea } from "@/components/ui/input";
import { KeyValue, Provenance } from "@/components/ui/data";
import { useAuth } from "@/features/auth/auth-context";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatDateTime, titleCase } from "@/lib/utils";

import type { AlertDetail, Txn } from "./types";

export const closeSchema = z.object({
  outcome: z.enum(["confirmed_fraud", "false_positive", "inconclusive"], { message: "Choose an outcome" }),
  note: z.string().trim().min(5, "Explain the outcome (at least 5 characters)").max(2000),
});
export type CloseForm = z.infer<typeof closeSchema>;

const noteSchema = z.object({ note: z.string().trim().min(2, "Write a note (at least 2 characters)").max(2000) });
type NoteForm = z.infer<typeof noteSchema>;

export function AlertDrawer({ alertId, onOpenChange }: { alertId: string | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={!!alertId} onOpenChange={onOpenChange}>
      {alertId && (
        <DialogContent side="right" size="xl" title="Fraud review case" description="Scores prioritise human review; they are not findings.">
          <AlertCase alertId={alertId} />
        </DialogContent>
      )}
    </Dialog>
  );
}

export function AlertCase({ alertId }: { alertId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const key = ["merchant", "fraud-alert", alertId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<AlertDetail>(`/merchant/fraud/alerts/${alertId}`) });
  const [mode, setMode] = React.useState<"escalate" | "close" | null>(null);

  const onDone = (msg: string) => (data: AlertDetail) => {
    qc.setQueryData(key, data);
    void qc.invalidateQueries({ queryKey: ["merchant", "fraud-alerts"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "fraud-eval"] });
    toast.success(msg);
  };
  const start = useMutation({ mutationFn: () => api.post<AlertDetail>(`/merchant/fraud/alerts/${alertId}/investigation`), onSuccess: onDone("Investigation started"), onError: (e) => toast.error(errorMessage(e)) });
  const addNote = useMutation({ mutationFn: (v: NoteForm) => api.post<AlertDetail>(`/merchant/fraud/alerts/${alertId}/notes`, v), onSuccess: onDone("Note added"), onError: (e) => toast.error(errorMessage(e)) });
  const escalate = useMutation({
    mutationFn: (v: NoteForm) => api.post<AlertDetail>(`/merchant/fraud/alerts/${alertId}/escalate`, v),
    onSuccess: (d) => { onDone("Escalated for senior review")(d); setMode(null); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const close = useMutation({
    mutationFn: (v: CloseForm) => api.post<AlertDetail>(`/merchant/fraud/alerts/${alertId}/close`, v),
    onSuccess: (d) => { onDone(`Closed as ${titleCase(d.outcome ?? "")}`)(d); setMode(null); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading) return <Skeleton className="h-[480px] w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const a = q.data!;
  const canAct = can("fraud.investigate") && a.status !== "closed";
  const ruleShare = 0.75 * a.rule_score;
  const anomalyShare = a.anomaly_score == null ? 0 : 0.25 * a.anomaly_score;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={a.risk_level} />
        <StatusBadge status={a.status} />
        {a.outcome && <StatusBadge status={a.outcome} />}
        <Badge variant="outline">{titleCase(a.subject_type)}</Badge>
        <span className="font-mono text-sm">{a.subject_ref}</span>
        <span className="ml-auto text-xs text-muted-foreground">Detected {formatDateTime(a.detected_at)}</span>
      </div>

      <Callout tone="warning" title="Human review required">{a.guidance}</Callout>

      <section aria-label="Score breakdown">
        <h3 className="mb-2 text-sm font-semibold">Risk score {a.risk_score.toFixed(1)} / 100</h3>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`Rule contribution ${ruleShare.toFixed(1)}, anomaly contribution ${anomalyShare.toFixed(1)}`}>
          <div className="h-full bg-danger" style={{ width: `${Math.min(100, ruleShare)}%` }} />
          <div className="h-full border-l-2 border-surface bg-accent" style={{ width: `${Math.min(100 - Math.min(100, ruleShare), anomalyShare)}%` }} />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rule score</span>
              <Provenance kind="rule" detail="Sum of the weights of configured deterministic rules that fired (capped at 100)." />
            </div>
            <p className="tabular mt-1 text-xl font-semibold">{a.rule_score.toFixed(0)}</p>
            <p className="text-xs text-muted-foreground">× 0.75 = {ruleShare.toFixed(1)} points</p>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Anomaly percentile</span>
              <Provenance kind="ml" detail="scikit-learn IsolationForest over the last 30 days of transactions; reported as a percentile (higher = more unusual)." />
            </div>
            <p className="tabular mt-1 text-xl font-semibold">{a.anomaly_score == null ? "—" : a.anomaly_score.toFixed(1)}</p>
            <p className="text-xs text-muted-foreground">{a.anomaly_score == null ? "Not scored for this subject type" : `× 0.25 = ${anomalyShare.toFixed(1)} points`}</p>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">risk = min(100, 0.75 × rule score + 0.25 × anomaly percentile). No demographic attributes are used.</p>
      </section>

      <section aria-label="Signals">
        <h3 className="mb-2 text-sm font-semibold">Signals ({a.signals.length})</h3>
        <ul className="flex flex-col gap-2">
          {a.signals.map((s, i) => (
            <li key={i} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="font-medium">{s.name}</p>
                <p className="text-sm text-muted-foreground">{s.detail}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono">{s.code}</span> · {titleCase(s.kind)}
                </p>
              </div>
              <Badge variant="danger" className="tabular shrink-0">+{s.weight}</Badge>
            </li>
          ))}
        </ul>
      </section>

      {a.transaction && (
        <section aria-label="Receipts">
          <h3 className="mb-2 text-sm font-semibold">Transaction vs original receipt</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <ReceiptCard title={a.transaction.type === "return" ? "This return" : "This transaction"} txn={a.transaction} compareTo={a.original_transaction ?? null} />
            {a.original_transaction ? (
              <ReceiptCard title="Original sale" txn={a.original_transaction} compareTo={null} />
            ) : (
              <div className="flex items-center justify-center rounded-md border border-dashed border-border-strong p-4 text-sm text-muted-foreground">
                No original receipt linked
              </div>
            )}
          </div>
        </section>
      )}

      {a.customer_history && (
        <section aria-label="Customer history">
          <h3 className="mb-2 text-sm font-semibold">Customer history <span className="font-normal text-muted-foreground">({a.customer_ref}, pseudonymised)</span></h3>
          <KeyValue items={Object.entries(a.customer_history).map(([k, v]) => [`${titleCase(k)}s`, `${v.count} · ${formatCurrency(v.value)}`])} />
        </section>
      )}

      <section aria-label="Investigation notes">
        <h3 className="mb-2 text-sm font-semibold">Investigation {a.investigation && <StatusBadge status={a.investigation.status} className="ml-1" />}</h3>
        {!a.investigation?.notes.length ? (
          <p className="text-sm text-muted-foreground">{a.investigation ? "No notes yet." : "No investigation opened."}</p>
        ) : (
          <ol className="relative flex flex-col gap-3 border-l border-border pl-4">
            {a.investigation.notes.map((n, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-primary" aria-hidden />
                <p className="text-xs text-muted-foreground">{n.author} · {formatDateTime(n.created_at)}</p>
                <p className="whitespace-pre-wrap text-sm">{n.note}</p>
              </li>
            ))}
          </ol>
        )}
        {canAct && <NoteForm onSubmit={(v, reset) => addNote.mutate(v, { onSuccess: reset })} busy={addNote.isPending} />}
      </section>

      {canAct && (
        <div className="sticky bottom-0 -mx-5 -mb-4 flex flex-wrap gap-2 border-t border-border bg-surface px-5 py-3">
          {!a.investigation && (
            <Button variant="outline" onClick={() => start.mutate()} loading={start.isPending}>
              <PlayCircle /> Start investigation
            </Button>
          )}
          {a.status !== "escalated" && (
            <Button variant="outline" onClick={() => setMode("escalate")}>
              <ArrowUpRight /> Escalate
            </Button>
          )}
          <Button onClick={() => setMode("close")}>
            <CircleCheck /> Close with outcome
          </Button>
        </div>
      )}

      <Dialog open={mode === "escalate"} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent title="Escalate for senior review" size="sm">
          <NoteForm submitLabel="Escalate" busy={escalate.isPending} onSubmit={(v) => escalate.mutate(v)} label="Reason for escalation" />
        </DialogContent>
      </Dialog>
      <Dialog open={mode === "close"} onOpenChange={(o) => !o && setMode(null)}>
        <DialogContent title="Close this case" description="The outcome is recorded in the audit log and feeds the evaluation metrics." size="sm">
          <CloseAlertForm busy={close.isPending} onSubmit={(v) => close.mutate(v)} onCancel={() => setMode(null)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NoteForm({ onSubmit, busy, submitLabel = "Add note", label = "Add a note" }: { onSubmit: (v: NoteForm, reset: () => void) => void; busy: boolean; submitLabel?: string; label?: string }) {
  const form = useForm<NoteForm>({ resolver: zodResolver(noteSchema), defaultValues: { note: "" } });
  const id = React.useId();
  return (
    <form onSubmit={form.handleSubmit((v) => onSubmit(v, () => form.reset({ note: "" })))} className="mt-3 flex flex-col gap-2" noValidate>
      <Field label={label} htmlFor={id} error={form.formState.errors.note?.message}>
        <Textarea id={id} rows={2} aria-invalid={!!form.formState.errors.note} placeholder="Facts checked, receipts verified, next steps…" {...form.register("note")} />
      </Field>
      <Button type="submit" variant="outline" size="sm" className="self-end" loading={busy}>
        <MessageSquarePlus /> {submitLabel}
      </Button>
    </form>
  );
}

export function CloseAlertForm({ onSubmit, onCancel, busy }: { onSubmit: (v: CloseForm) => void; onCancel: () => void; busy?: boolean }) {
  const form = useForm<CloseForm>({ resolver: zodResolver(closeSchema), defaultValues: { outcome: undefined, note: "" } });
  const e = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <Field label="Outcome" htmlFor="close-outcome" error={e.outcome?.message}>
        <Select id="close-outcome" aria-invalid={!!e.outcome} defaultValue="" {...form.register("outcome")}>
          <option value="" disabled>Select an outcome</option>
          <option value="confirmed_fraud">Confirmed fraud</option>
          <option value="false_positive">False positive</option>
          <option value="inconclusive">Inconclusive</option>
        </Select>
      </Field>
      <Field label="Reviewer note" htmlFor="close-note" error={e.note?.message} hint="Required. Describe the evidence reviewed.">
        <Textarea id="close-note" aria-invalid={!!e.note} {...form.register("note")} />
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={busy}>
          <ShieldAlert /> Close case
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Lines whose returned quantity exceeds the original receipt, or where the scale detected more than was charged. */
export function lineIssues(txn: Txn, original: Txn | null): string[][] {
  const orig = new Map<string, number>();
  for (const i of original?.items ?? []) orig.set(i.product ?? "", (orig.get(i.product ?? "") ?? 0) + i.quantity);
  return txn.items.map((i) => {
    const out: string[] = [];
    if (original && txn.type === "return" && i.quantity > (orig.get(i.product ?? "") ?? 0)) {
      out.push(orig.has(i.product ?? "") ? `Returned ${i.quantity}, original ${orig.get(i.product ?? "")}` : "Not on original receipt");
    }
    if (i.detected_quantity != null && i.detected_quantity > i.quantity) out.push(`Scale detected ${i.detected_quantity}, charged ${i.quantity}`);
    return out;
  });
}

function ReceiptCard({ title, txn, compareTo }: { title: string; txn: Txn; compareTo: Txn | null }) {
  const issues = lineIssues(txn, compareTo);
  const showDetected = txn.items.some((i) => i.detected_quantity != null);
  return (
    <div className="rounded-md border border-border">
      <div className="border-b border-border px-3 py-2">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono">{txn.receipt_number}</span> · {titleCase(txn.type)} · {titleCase(txn.channel)}
          {txn.terminal_id ? ` · ${txn.terminal_id}` : ""} · {formatDateTime(txn.occurred_at)}
          {txn.is_simulated && " · simulated"}
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-1.5 font-medium">Item</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Qty</th>
            {showDetected && <th scope="col" className="px-2 py-1.5 text-right font-medium">Detected</th>}
            <th scope="col" className="px-3 py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {txn.items.map((i, idx) => (
            <tr key={idx} className={cn("border-t border-border", issues[idx].length && "bg-danger-soft")}>
              <td className="px-3 py-1.5">
                {i.product ?? "Unknown product"}
                {issues[idx].map((m) => (
                  <span key={m} className="block text-xs font-medium text-danger">{m}</span>
                ))}
              </td>
              <td className="tabular px-2 py-1.5 text-right">{i.quantity}</td>
              {showDetected && <td className={cn("tabular px-2 py-1.5 text-right", (i.detected_quantity ?? 0) > i.quantity && "font-semibold text-danger")}>{i.detected_quantity ?? "—"}</td>}
              <td className="tabular px-3 py-1.5 text-right">{formatCurrency(i.line_total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <td className="px-3 py-1.5" colSpan={showDetected ? 3 : 2}>Total</td>
            <td className="tabular px-3 py-1.5 text-right">{formatCurrency(txn.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
