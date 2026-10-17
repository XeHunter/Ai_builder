import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CheckCheck, FlaskConical, Hammer, LayoutGrid, Map as MapIcon, X } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { StoreMap } from "@/components/maps/StoreMap";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, Skeleton } from "@/components/ui/feedback";
import { Field, Textarea } from "@/components/ui/input";
import { KeyValue, Provenance } from "@/components/ui/data";
import { useAuth } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import { formatDate, titleCase } from "@/lib/utils";

import { plainError, useActiveLayout, violationsFrom } from "./layout-api";
import { actionsForStatus, formatEvidence, REC_TYPE, type RecAction } from "./recommendation-utils";
import type { ApplyResult, Outcome, RecLocation, Recommendation, RecType } from "./types";

const REVIEW_TARGET: Partial<Record<RecAction, { status: string; label: string; title: string; description: string }>> = {
  accept: { status: "accepted", label: "Accept", title: "Accept recommendation", description: "Accepting queues the test for implementation. Nothing changes on the shop floor yet." },
  reject: { status: "rejected", label: "Reject", title: "Reject recommendation", description: "Rejected recommendations are kept for the audit trail and not proposed again while open." },
  implement: { status: "implemented", label: "Mark implemented", title: "Mark as implemented", description: "Records today as the implementation date and starts observational outcome tracking." },
  complete: { status: "completed", label: "Mark completed", title: "Complete the test", description: "Freezes the before/after measurement as the recorded outcome." },
};

export function RecommendationCard({ rec, showMap = true }: { rec: Recommendation; showMap?: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [dialog, setDialog] = React.useState<RecAction | null>(null);
  const [note, setNote] = React.useState("");
  const [mapOpen, setMapOpen] = React.useState(showMap);
  const [applied, setApplied] = React.useState<ApplyResult | null>(null);
  const type = REC_TYPE[rec.rec_type as RecType] ?? { label: titleCase(rec.rec_type), variant: "info" as const };
  const actions = actionsForStatus(rec.status, {
    canManage: can("merchandising.manage"),
    canWriteLayout: can("layout.write"),
    hasProposedLocation: Boolean(rec.proposed_location),
  });
  const tracked = rec.status === "implemented" || rec.status === "completed";

  const detail = useQuery({
    queryKey: ["merchant", "merch-rec", rec.id, rec.status],
    queryFn: () => api.get<Recommendation>(`/merchant/merchandising/recommendations/${rec.id}`),
    enabled: tracked,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["merchant", "merch-recs"] });

  const review = useMutation({
    mutationFn: (v: { status: string; note?: string }) => api.post<Recommendation>(`/merchant/merchandising/recommendations/${rec.id}/review`, v),
    onSuccess: (r) => {
      toast.success(`Recommendation ${r.status}`);
      setDialog(null);
      setNote("");
      invalidate();
    },
    onError: (err) => toast.error(plainError(err)),
  });

  const apply = useMutation({
    mutationFn: () => api.post<ApplyResult>(`/merchant/merchandising/recommendations/${rec.id}/apply-to-draft`),
    onSuccess: (r) => {
      setApplied(r);
      toast.success(`Added to draft layout on ${r.shelf_code}`, { description: "Review and publish it from the layout editor." });
      invalidate();
      void qc.invalidateQueries({ queryKey: ["merchant", "layouts"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "layout"] });
    },
    onError: (err) => {
      const v = violationsFrom(err);
      toast.error(plainError(err), { description: v.map((x) => x.message).join(" ") || undefined });
    },
  });

  const evidence = Object.entries(rec.evidence ?? {});
  const plan = rec.ab_test_plan ?? {};
  const isExperiment = Boolean(plan.primary_metric);
  const outcome: Outcome | undefined = detail.data?.live_outcome ?? (rec.outcome && "before" in rec.outcome ? (rec.outcome as Outcome) : undefined);
  const dlg = dialog ? REVIEW_TARGET[dialog] : undefined;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={type.variant}>{type.label}</Badge>
          <StatusBadge status={rec.status} />
          <Badge variant={rec.evidence_quality === "high" ? "success" : rec.evidence_quality === "medium" ? "warning" : "neutral"}>
            Evidence: {rec.evidence_quality}
          </Badge>
          <Provenance kind={rec.rec_type === "safety_relocation" ? "rule" : "statistical"} detail={rec.rec_type === "adjacency_test" ? "Derived from association rules (support, confidence, lift) over past baskets and walking distance on the store graph." : undefined} />
          <span className="ml-auto text-xs text-muted-foreground">{formatDate(rec.created_at)}</span>
        </div>
        <h3 className="text-base font-semibold leading-snug">{rec.title}</h3>
        <p className="text-sm text-muted-foreground">{rec.rationale}</p>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <section aria-label="Evidence">
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</h4>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {evidence.map(([k, v]) => {
                  const [label, val] = formatEvidence(k, v);
                  return (
                    <tr key={k}>
                      <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">{label}</th>
                      <td className="tabular py-1 text-right font-medium">{val}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <section aria-label="Expected metric and steps">
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Metric to watch</h4>
            <p className="text-sm">{rec.expected_metric}</p>
            <h4 className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Implementation steps</h4>
            <ol className="list-decimal space-y-0.5 pl-5 text-sm">
              {rec.implementation_steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
          <section aria-label="Test plan" className="rounded-md border border-border bg-surface-raised p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <FlaskConical className="size-3.5" aria-hidden /> {isExperiment ? "A/B test plan" : "Plan"}
            </h4>
            {isExperiment ? (
              <KeyValue
                items={[
                  ["Design", plan.design ?? "—"],
                  ["Primary metric", titleCase(plan.primary_metric ?? "—")],
                  ["Baseline", plan.baseline_rate != null ? (plan.primary_metric === "attach_rate" ? `${(plan.baseline_rate * 100).toFixed(1)}%` : String(plan.baseline_rate)) : "—"],
                  ["Min. detectable change", plan.minimum_detectable_change != null ? (plan.primary_metric === "attach_rate" ? `${(plan.minimum_detectable_change * 100).toFixed(1)} pts` : String(plan.minimum_detectable_change)) : "—"],
                  ["Baskets per arm", plan.baskets_needed_per_arm?.toLocaleString("en-IN") ?? "—"],
                  ["Duration", plan.estimated_duration_weeks ? `${plan.estimated_duration_weeks} weeks` : "—"],
                  ["Stop rule", plan.stop_rule ?? "—"],
                ]}
              />
            ) : (
              <p className="text-sm">{plan.design ?? "No experiment required."}</p>
            )}
          </section>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <LocationBox label="Current" loc={rec.current_location} tone="warning" />
            <ArrowRight className="mx-auto hidden size-4 text-muted-foreground sm:block" aria-hidden />
            <LocationBox label="Proposed" loc={rec.proposed_location} tone="accent" />
          </div>
          {rec.related_product && (
            <p className="text-xs text-muted-foreground">
              Anchor product: <span className="font-medium text-foreground">{rec.related_product}</span>
            </p>
          )}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setMapOpen((o) => !o)} aria-expanded={mapOpen}>
            <MapIcon /> {mapOpen ? "Hide floor plan" : "Show on floor plan"}
          </Button>
          {mapOpen && <MiniMap storeId={rec.store_id} current={rec.current_location} proposed={rec.proposed_location} />}
          {tracked && <OutcomePanel outcome={outcome} loading={detail.isLoading} completed={rec.status === "completed"} />}
          {rec.review_note && (
            <p className="text-xs text-muted-foreground">
              Review note: <span className="text-foreground">{rec.review_note}</span>
            </p>
          )}
          {applied && (
            <Callout title={`Applied to draft on ${applied.shelf_code}`}>
              {applied.warnings.length > 0 && <p>Warnings: {applied.warnings.map((w) => w.message).join(" ")}</p>}
              <Link to="/merchant/layout" className="font-medium text-primary underline-offset-4 hover:underline">
                Open the draft in the layout editor
              </Link>
            </Callout>
          )}
        </div>
      </CardContent>
      {actions.length > 0 && (
        <CardFooter className="flex-wrap">
          {actions.map((a) => {
            if (a === "apply")
              return (
                <Button key={a} variant="outline" size="sm" onClick={() => apply.mutate()} loading={apply.isPending}>
                  <LayoutGrid /> Apply to draft layout
                </Button>
              );
            const t = REVIEW_TARGET[a]!;
            const Icon = a === "accept" ? Check : a === "reject" ? X : a === "implement" ? Hammer : CheckCheck;
            return (
              <Button key={a} size="sm" variant={a === "reject" ? "ghost" : a === "accept" ? "default" : "outline"} onClick={() => setDialog(a)}>
                <Icon /> {t.label}
              </Button>
            );
          })}
        </CardFooter>
      )}
      <Dialog open={!!dlg} onOpenChange={(o) => !o && setDialog(null)}>
        {dlg && (
          <DialogContent title={dlg.title} description={dlg.description} size="sm">
            <Field label="Note (optional)" htmlFor={`note-${rec.id}`}>
              <Textarea id={`note-${rec.id}`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason or context for the audit trail" />
            </Field>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant={dialog === "reject" ? "destructive" : "default"} loading={review.isPending}
                onClick={() => review.mutate({ status: dlg.status, note: note.trim() || undefined })}>
                {dlg.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

function LocationBox({ label, loc, tone }: { label: string; loc: RecLocation | null; tone: "warning" | "accent" }) {
  return (
    <div className={tone === "warning" ? "rounded-md border border-warning/30 bg-warning-soft p-2.5" : "rounded-md border border-accent/30 bg-accent-soft p-2.5"}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {loc ? (
        <>
          <p className="font-mono text-sm font-semibold">{loc.code}</p>
          <p className="text-xs text-foreground/80">
            Level {loc.level} · {loc.fixture}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Not set</p>
      )}
    </div>
  );
}

function MiniMap({ storeId, current, proposed }: { storeId: string; current: RecLocation | null; proposed: RecLocation | null }) {
  const { layout, isLoading, error } = useActiveLayout(storeId);
  const highlight = React.useMemo(() => (current ? [current.code] : []), [current]);
  if (error) return <p className="text-sm text-danger">Floor plan unavailable: {plainError(error)}</p>;
  if (isLoading || !layout) return <Skeleton className="aspect-[4/3] w-full" />;
  return (
    <div>
      <StoreMap
        layout={layout}
        highlight={highlight}
        selectedShelfCode={proposed?.code ?? null}
        showWalkways={false}
        ariaLabel={`Active floor plan: current location ${current?.code ?? "none"} highlighted in amber, proposed location ${proposed?.code ?? "none"} in indigo`}
      />
      <p className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-warning" aria-hidden /> Current</span>
        <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-accent" aria-hidden /> Proposed</span>
        <span>Active layout v{layout.version}</span>
      </p>
    </div>
  );
}

function OutcomePanel({ outcome, loading, completed }: { outcome?: Outcome; loading: boolean; completed: boolean }) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (!outcome || !outcome.before) return null;
  const attach = outcome.before.attach_rate !== undefined || outcome.after?.attach_rate !== undefined;
  const fmt = (w?: { attach_rate?: number | null; units_per_day?: number }) =>
    attach ? (w?.attach_rate == null ? "—" : `${(w.attach_rate * 100).toFixed(1)}%`) : w?.units_per_day == null ? "—" : w.units_per_day.toFixed(2);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{completed ? "Recorded outcome" : "Live outcome"}</h4>
        <Badge variant="warning">Observational</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        {(["before", "after"] as const).map((k) => (
          <div key={k}>
            <p className="text-xs text-muted-foreground">
              {k === "before" ? `${outcome.window_days ?? 28} days before` : "Since implementation"}
            </p>
            <p className="tabular text-lg font-semibold">{fmt(outcome[k])}</p>
            <p className="text-xs text-muted-foreground">
              {attach ? "attach rate" : "baskets/day with product"} · {outcome[k]?.baskets ?? 0} baskets
            </p>
          </div>
        ))}
      </div>
      {outcome.caveat && <p className="mt-2 text-xs text-muted-foreground">{outcome.caveat}</p>}
    </div>
  );
}
