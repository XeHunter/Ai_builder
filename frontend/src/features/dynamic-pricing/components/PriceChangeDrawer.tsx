import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Send, Upload, XCircle } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KeyValue, Provenance } from "@/components/ui/data";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Callout, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { useAuth } from "@/features/auth/auth-context";
import { ConfirmDialog, GuardrailError } from "@/features/merchant-dashboard/components/common";
import { api } from "@/lib/api";
import { formatCurrency, formatDateTime, formatNumber, formatPct, hoursLabel, titleCase } from "@/lib/utils";

import type { PriceChange, PriceChangeStatus } from "../types";

export type PriceAction = "submit" | "approve_publish" | "approve" | "publish" | "reject" | "cancel";

/** Which workflow actions are available for a price change in a given state, for the current user. */
export function priceChangeActions(status: PriceChangeStatus, can: (p: string) => boolean): PriceAction[] {
  const out: PriceAction[] = [];
  const open = status === "RECOMMENDED" || status === "PENDING_APPROVAL";
  if (status === "RECOMMENDED" && can("pricing.recommend")) out.push("submit");
  if (open && can("pricing.approve") && can("pricing.publish")) out.push("approve_publish");
  if (open && can("pricing.approve")) out.push("approve");
  if ((status === "APPROVED" || status === "FAILED") && can("pricing.publish")) out.push("publish");
  if (open && can("pricing.approve")) out.push("reject");
  if ((open || status === "APPROVED" || status === "FAILED") && can("pricing.recommend")) out.push("cancel");
  return out;
}

export function invalidatePricing(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["merchant", "pricing"] });
  void qc.invalidateQueries({ queryKey: ["merchant", "expiry"] });
  void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
  void qc.invalidateQueries({ queryKey: ["merchant", "inventory"] });
}

export function PriceChangeDrawer({ changeId, onClose }: { changeId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["merchant", "pricing", "change", changeId],
    queryFn: () => api.get<PriceChange>(`/merchant/pricing/changes/${changeId}`),
    enabled: Boolean(changeId),
  });
  return (
    <Dialog open={Boolean(changeId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent side="right" size="xl" title={q.data ? q.data.product : "Price change"} description={q.data ? `${q.data.sku} · ${q.data.store_code}${q.data.batch_code ? ` · batch ${q.data.batch_code}` : ""}` : undefined}>
        {q.isLoading ? <SkeletonRows rows={6} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data ? <ChangeDetail pc={q.data} /> : null}
      </DialogContent>
    </Dialog>
  );
}

const EVIDENCE_LABELS: [keyof PriceChange["evidence"], string, (v: number) => string][] = [
  ["hours_to_sell_by", "Time to sell-by", (v) => hoursLabel(v)],
  ["remaining_units", "Remaining units", (v) => formatNumber(v)],
  ["daily_velocity_14d", "Sales velocity (14 days)", (v) => `${formatNumber(v, 2)} / day`],
  ["expected_units_no_action", "Expected sales without markdown", (v) => formatNumber(v, 1)],
  ["expected_units_with_action", "Expected sales with markdown", (v) => formatNumber(v, 1)],
  ["expected_leftover_units", "Expected leftover units", (v) => formatNumber(v, 1)],
  ["tier_cap_pct", "Tier discount cap", (v) => `${v}%`],
  ["floor_price", "Price floor", (v) => formatCurrency(v)],
  ["unit_cost", "Unit cost", (v) => formatCurrency(v)],
];

function ChangeDetail({ pc }: { pc: PriceChange }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [confirm, setConfirm] = React.useState<null | "reject" | "cancel">(null);
  const actions = priceChangeActions(pc.status, can);

  const m = useMutation({
    mutationFn: ({ action, note }: { action: PriceAction; note?: string }) => {
      const base = `/merchant/pricing/changes/${pc.id}`;
      switch (action) {
        case "submit":
          return api.post<PriceChange>(`${base}/submit`, { note: note || null });
        case "approve_publish":
          return api.post<PriceChange>(`${base}/approve`, { note: note || null, publish: true });
        case "approve":
          return api.post<PriceChange>(`${base}/approve`, { note: note || null, publish: false });
        case "publish":
          return api.post<PriceChange>(`${base}/publish`);
        case "reject":
          return api.post<PriceChange>(`${base}/reject`, { note: note || null });
        case "cancel":
          return api.post<PriceChange>(`${base}/cancel`, { note: note || null });
      }
    },
    onSuccess: (r) => {
      qc.setQueryData(["merchant", "pricing", "change", pc.id], r);
      invalidatePricing(qc);
      setConfirm(null);
      if (r.status === "FAILED") toast.error("Publication failed", { description: r.failure_reason ?? undefined });
      else toast.success(`Price change ${titleCase(r.status.toLowerCase())}`);
    },
  });
  const ev = pc.evidence ?? {};
  const evidenceRows = EVIDENCE_LABELS.filter(([k]) => typeof ev[k] === "number").map(([k, label, fmt]) => [label, fmt(ev[k] as number)] as [string, string]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={pc.status} />
        <Badge variant="outline">{titleCase(pc.source)}</Badge>
        {pc.quantity_affected > 0 && <Badge>{pc.quantity_affected} units affected</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised p-4">
        <div>
          <p className="text-xs text-muted-foreground">Current</p>
          <p className="tabular text-lg font-semibold">{formatCurrency(pc.current_price)}</p>
        </div>
        <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
        <div>
          <p className="text-xs text-muted-foreground">Proposed</p>
          <p className="tabular text-lg font-semibold text-primary">{formatCurrency(pc.proposed_price)}</p>
        </div>
        <div className="ml-auto grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Change</p>
            <p className="tabular font-medium">{pc.discount_pct > 0 ? `−${pc.discount_pct}%` : pc.proposed_price > pc.current_price ? "increase" : "0%"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Floor</p>
            <p className="tabular font-medium">{formatCurrency(pc.floor_price)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Margin after</p>
            <p className="tabular font-medium">{formatPct(pc.projected_margin_pct, 1)}</p>
          </div>
        </div>
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Workflow actions">
          {actions.includes("submit") && (
            <Button variant="outline" onClick={() => m.mutate({ action: "submit" })} loading={m.isPending && m.variables?.action === "submit"} disabled={m.isPending}>
              <Send /> Submit for approval
            </Button>
          )}
          {actions.includes("approve_publish") && (
            <Button onClick={() => m.mutate({ action: "approve_publish" })} loading={m.isPending && m.variables?.action === "approve_publish"} disabled={m.isPending}>
              <CheckCircle2 /> Approve & publish
            </Button>
          )}
          {actions.includes("approve") && (
            <Button variant="outline" onClick={() => m.mutate({ action: "approve" })} loading={m.isPending && m.variables?.action === "approve"} disabled={m.isPending}>
              Approve only
            </Button>
          )}
          {actions.includes("publish") && (
            <Button onClick={() => m.mutate({ action: "publish" })} loading={m.isPending && m.variables?.action === "publish"} disabled={m.isPending}>
              <Upload /> {pc.status === "FAILED" ? "Retry publish" : "Publish"}
            </Button>
          )}
          {actions.includes("reject") && (
            <Button variant="outline" onClick={() => { m.reset(); setConfirm("reject"); }} disabled={m.isPending}>
              <XCircle /> Reject
            </Button>
          )}
          {actions.includes("cancel") && (
            <Button variant="ghost" onClick={() => { m.reset(); setConfirm("cancel"); }} disabled={m.isPending}>
              Cancel change
            </Button>
          )}
        </div>
      )}
      {!confirm && m.error ? <GuardrailError error={m.error} /> : null}

      {pc.failure_reason && (
        <Callout tone="warning" title="Publication failed">
          {pc.failure_reason}
        </Callout>
      )}
      {pc.publish_reference && (
        <Callout tone="simulated" title="Published via simulated shelf-label / POS publisher">
          Reference <span className="font-mono">{pc.publish_reference}</span>
          {pc.published_at ? ` · ${formatDateTime(pc.published_at)}` : ""}. No real device was contacted.
        </Callout>
      )}

      <section>
        <h3 className="mb-1 text-sm font-semibold">Reason</h3>
        <p className="text-sm text-foreground/85">{pc.reason}</p>
      </section>

      {(evidenceRows.length > 0 || ev.reasons?.length || ev.method) && (
        <section className="rounded-lg border border-border p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Evidence</h3>
            {ev.method && <Provenance kind={String(ev.method).includes("heuristic") ? "heuristic" : "rule"} detail={ev.assumption ? `Assumption: ${ev.assumption}` : undefined} />}
          </div>
          {evidenceRows.length > 0 && <KeyValue items={evidenceRows} />}
          {ev.reasons && ev.reasons.length > 0 && (
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-foreground/85">
              {ev.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {(ev.method || ev.assumption) && (
            <p className="mt-3 text-xs text-muted-foreground">
              Method: {titleCase(String(ev.method ?? "—"))}
              {ev.assumption ? ` · Assumption: ${ev.assumption}` : ""}
            </p>
          )}
        </section>
      )}

      {pc.clearance_instruction && (
        <Callout title="Clearance instruction">{pc.clearance_instruction}</Callout>
      )}

      <KeyValue
        items={[
          ["Requested by", pc.requested_by ?? "—"],
          ["Approved by", pc.approved_by ?? "—"],
          ["Created", formatDateTime(pc.created_at)],
          ["Approved", formatDateTime(pc.approved_at)],
          ["Published", formatDateTime(pc.published_at)],
          ["Effective until", formatDateTime(pc.effective_until)],
        ]}
      />

      <section>
        <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
        <ol className="relative space-y-3 border-l border-border pl-4">
          {pc.events.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="absolute -left-1.5 mt-1 size-3 rounded-full border-2 border-surface bg-primary" aria-hidden />
              <div className="flex flex-wrap items-center gap-1.5">
                {e.from && (
                  <>
                    <StatusBadge status={e.from} />
                    <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
                  </>
                )}
                <StatusBadge status={e.to} />
                <span className="text-xs text-muted-foreground">
                  {e.actor} · {formatDateTime(e.at)}
                </span>
              </div>
              {e.note && <p className="mt-0.5 text-xs text-foreground/80">{e.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "reject" ? "Reject this price change?" : "Cancel this price change?"}
        description={confirm === "reject" ? "The recommendation will be closed and cannot be reopened." : "The change will be withdrawn and cannot be published afterwards."}
        confirmLabel={confirm === "reject" ? "Reject" : "Cancel change"}
        destructive
        withNote
        noteLabel={confirm === "reject" ? "Reason for rejection" : "Reason (optional)"}
        noteRequired={confirm === "reject"}
        loading={m.isPending}
        error={m.error}
        onConfirm={(note) => confirm && m.mutate({ action: confirm, note })}
      />
    </div>
  );
}
