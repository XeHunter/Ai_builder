import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, Ticket } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue, Provenance } from "@/components/ui/data";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { ConfirmDialog, FilterChips, GuardrailError } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";
import { formatCurrency, formatDateTime, formatNumber, formatPct, titleCase } from "@/lib/utils";

import type { Promotion, PromotionDetail, PromotionStatus } from "../types";
import { PromotionFormDialog } from "./PromotionFormDialog";

export type PromoAction = "submit" | "approve" | "reject" | "pause" | "resume" | "end" | "cancel";

const PROMO_ACTIONS: Record<PromotionStatus, PromoAction[]> = {
  draft: ["submit", "cancel"],
  pending_approval: ["approve", "reject", "cancel"],
  scheduled: ["pause", "cancel"],
  active: ["pause", "end"],
  paused: ["resume", "end", "cancel"],
  ended: [],
  rejected: [],
  cancelled: [],
};

const ACTION_LABEL: Record<PromoAction, string> = { submit: "Submit", approve: "Approve", reject: "Reject", pause: "Pause", resume: "Resume", end: "End now", cancel: "Cancel" };
const DESTRUCTIVE: PromoAction[] = ["reject", "end", "cancel"];

/** Allowed promotion actions for a status and the current user's permissions. */
export function promotionActions(status: PromotionStatus, can: (p: string) => boolean, isSimulation = false): PromoAction[] {
  if (!can("pricing.recommend")) return [];
  return (PROMO_ACTIONS[status] ?? []).filter((a) => {
    if (a === "approve") return can("pricing.approve") && !isSimulation;
    if (a === "reject") return can("pricing.approve");
    return true;
  });
}

const FILTERS = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "scheduled,active", label: "Scheduled / active" },
  { value: "paused", label: "Paused" },
  { value: "ended,rejected,cancelled", label: "Closed" },
];

function describeDiscount(p: Pick<Promotion, "promo_type" | "discount_value">) {
  return p.promo_type === "percent_off" ? `${p.discount_value}% off` : `${formatCurrency(p.discount_value)} off`;
}

function usePromotionAction(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: PromoAction }) => api.post<Promotion>(`/merchant/promotions/${id}/actions`, { action }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["merchant", "pricing"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
      toast.success(`"${p.name}" is now ${titleCase(p.status).toLowerCase()}`);
      onDone?.();
    },
  });
}

export function PromotionsTab({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const { can } = useAuth();
  const [status, setStatus] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const q = useQuery({ queryKey: ["merchant", "pricing", "promotions", status], queryFn: () => api.get<Promotion[]>("/merchant/promotions", { status }) });

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Promotion status" options={FILTERS} value={status} onChange={setStatus} />
          {can("pricing.recommend") && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New promotion
            </Button>
          )}
        </div>
        {q.isLoading ? (
          <SkeletonRows rows={5} className="p-3" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-3" />
        ) : !q.data?.length ? (
          <EmptyState className="m-3" title="No promotions" description="Create a promotion, or start one from a weather opportunity." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Promotion</TH>
                <TH>Store</TH>
                <TH>Discount</TH>
                <TH>Window</TH>
                <TH className="text-right">Products</TH>
                <TH className="text-right">Used</TH>
                <TH>Status</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.map((p) => (
                <PromotionRow key={p.id} p={p} onOpen={() => onOpen(p.id)} />
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <RedeemCoupon />
      <PromotionFormDialog open={creating} onOpenChange={setCreating} onCreated={(p) => onOpen(p.id)} />
      <PromotionDrawer promoId={openId} onClose={() => onOpen(null)} />
    </div>
  );
}

function PromotionRow({ p, onOpen }: { p: Promotion; onOpen: () => void }) {
  const { can } = useAuth();
  const [confirm, setConfirm] = React.useState<PromoAction | null>(null);
  const m = usePromotionAction(() => setConfirm(null));
  const actions = promotionActions(p.status, can, p.is_simulation);
  const run = (a: PromoAction) => {
    m.reset();
    if (DESTRUCTIVE.includes(a)) setConfirm(a);
    else m.mutate({ id: p.id, action: a }, { onError: (e) => toast.error(errorMessage(e)) });
  };
  return (
    <TR>
      <TD>
        <button type="button" className="text-left font-medium hover:text-primary hover:underline" onClick={onOpen}>
          {p.name}
        </button>
        <div className="flex flex-wrap gap-1 pt-0.5">
          {p.trigger !== "manual" && <Badge variant="info">{titleCase(p.trigger)}</Badge>}
          {p.geofence_radius_m && (
            <Badge>
              <MapPin className="size-3" aria-hidden /> {formatNumber(p.geofence_radius_m)} m
            </Badge>
          )}
        </div>
      </TD>
      <TD className="text-sm">{p.store_name}</TD>
      <TD className="whitespace-nowrap">{describeDiscount(p)}</TD>
      <TD className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(p.starts_at)} → {formatDateTime(p.ends_at)}
      </TD>
      <TD className="tabular text-right">{p.products.length}</TD>
      <TD className="tabular text-right">
        {p.usage_count}
        {p.usage_limit ? ` / ${p.usage_limit}` : ""}
      </TD>
      <TD>
        <StatusBadge status={p.status} />
      </TD>
      <TD className="whitespace-nowrap text-right">
        <div className="flex justify-end gap-1">
          {actions.map((a) => (
            <Button key={a} size="sm" variant={a === "approve" ? "default" : DESTRUCTIVE.includes(a) ? "ghost" : "outline"} disabled={m.isPending} loading={m.isPending && m.variables?.action === a} onClick={() => run(a)}>
              {ACTION_LABEL[a]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={onOpen}>
            Details
          </Button>
        </div>
        <ConfirmDialog
          open={confirm !== null}
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`${confirm ? ACTION_LABEL[confirm] : ""} "${p.name}"?`}
          description={confirm === "end" ? "The promotion stops immediately and cannot be restarted." : "This cannot be undone."}
          confirmLabel={confirm ? ACTION_LABEL[confirm] : "Confirm"}
          destructive
          loading={m.isPending}
          error={m.error}
          onConfirm={() => confirm && m.mutate({ id: p.id, action: confirm })}
        />
      </TD>
    </TR>
  );
}

function PromotionDrawer({ promoId, onClose }: { promoId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["merchant", "pricing", "promotion", promoId], queryFn: () => api.get<PromotionDetail>(`/merchant/promotions/${promoId}`), enabled: Boolean(promoId) });
  const [confirm, setConfirm] = React.useState<PromoAction | null>(null);
  const m = usePromotionAction(() => setConfirm(null));
  const p = q.data;
  const actions = p ? promotionActions(p.status, can, p.is_simulation) : [];
  return (
    <Dialog open={Boolean(promoId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent side="right" size="xl" title={p?.name ?? "Promotion"} description={p ? `${p.store_name} · ${describeDiscount(p)}` : undefined}>
        {q.isLoading ? (
          <SkeletonRows rows={6} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : p ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={p.status} />
              <Badge variant="outline">Trigger: {titleCase(p.trigger)}</Badge>
              {p.is_simulation && <Badge variant="accent">Simulation</Badge>}
            </div>
            {p.description && <p className="text-sm text-foreground/85">{p.description}</p>}
            {actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {actions.map((a) => (
                  <Button
                    key={a}
                    variant={a === "approve" ? "default" : DESTRUCTIVE.includes(a) ? "outline" : "secondary"}
                    disabled={m.isPending}
                    loading={m.isPending && m.variables?.action === a && !confirm}
                    onClick={() => {
                      m.reset();
                      if (DESTRUCTIVE.includes(a)) setConfirm(a);
                      else m.mutate({ id: p.id, action: a });
                    }}
                  >
                    {ACTION_LABEL[a]}
                  </Button>
                ))}
              </div>
            )}
            {!confirm && m.error ? <GuardrailError error={m.error} /> : null}
            <KeyValue
              items={[
                ["Window", `${formatDateTime(p.starts_at)} → ${formatDateTime(p.ends_at)}`],
                ["Usage", `${p.usage_count}${p.usage_limit ? ` of ${p.usage_limit}` : ""} · ${p.per_customer_limit} per customer`],
                ["Geofence", p.geofence_radius_m ? `${formatNumber(p.geofence_radius_m)} m around the store` : "None"],
                ["Approved", formatDateTime(p.approved_at)],
                ["Created", formatDateTime(p.created_at)],
              ]}
            />
            <section>
              <h3 className="mb-2 text-sm font-semibold">Products</h3>
              <div className="rounded-md border border-border">
                <Table>
                  <THead>
                    <TR>
                      <TH>Product</TH>
                      <TH className="text-right">Regular</TH>
                      <TH className="text-right">Promo</TH>
                      <TH className="text-right">Margin at promo</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {p.products.map((pp) => (
                      <TR key={pp.product_id}>
                        <TD>
                          <div className="font-medium">{pp.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">{pp.sku}</div>
                        </TD>
                        <TD className="tabular text-right">{formatCurrency(pp.regular_price)}</TD>
                        <TD className="tabular text-right font-medium">{formatCurrency(pp.promo_price)}</TD>
                        <TD className="tabular text-right">{formatPct(pp.margin_at_promo_pct, 1)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </section>
            <section className="rounded-lg border border-border p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">Performance</h3>
                <Badge variant="warning">Observational</Badge>
                <Provenance kind="statistical" detail="Before/after comparison of units sold; not a causal uplift estimate." />
              </div>
              <KeyValue
                items={[
                  ["Coupons issued", formatNumber(p.performance.coupons_issued)],
                  ["Redemptions", formatNumber(p.performance.redemptions)],
                  ["Window compared", `${p.performance.window_days} days`],
                  ["Units during promotion", formatNumber(p.performance.units_during)],
                  ["Units in preceding window", formatNumber(p.performance.units_before)],
                  ["Change", p.performance.change_pct === null ? "—" : `${p.performance.change_pct > 0 ? "+" : ""}${p.performance.change_pct}%`],
                  ["Method", titleCase(p.performance.method)],
                ]}
              />
              <p className="mt-3 text-xs text-muted-foreground">{p.performance.caveat}</p>
            </section>
            {Object.keys(p.evidence ?? {}).length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Evidence</h3>
                <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(p.evidence, null, 2)}</pre>
              </section>
            )}
            <ConfirmDialog
              open={confirm !== null}
              onOpenChange={(o) => !o && setConfirm(null)}
              title={`${confirm ? ACTION_LABEL[confirm] : ""} this promotion?`}
              description="This cannot be undone."
              confirmLabel={confirm ? ACTION_LABEL[confirm] : "Confirm"}
              destructive
              loading={m.isPending}
              error={m.error}
              onConfirm={() => confirm && m.mutate({ id: p.id, action: confirm })}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RedeemCoupon() {
  const qc = useQueryClient();
  const [code, setCode] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const m = useMutation({
    mutationFn: (c: string) => api.post<{ coupon_id: string; redeemed_at: string; simulated_pos: boolean }>("/merchant/coupons/redeem", { code: c }),
    onSuccess: (r) => {
      toast.success("Coupon redeemed (simulated POS)", { description: formatDateTime(r.redeemed_at) });
      setCode("");
      setTouched(false);
      void qc.invalidateQueries({ queryKey: ["merchant", "pricing"] });
    },
  });
  const invalid = code.trim().length < 4 || code.trim().length > 32;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ticket className="size-4" aria-hidden /> Redeem a coupon at the till
          <Provenance kind="simulated" />
        </CardTitle>
        <CardDescription>Simulated point-of-sale redemption. Enforces coupon status, expiry and usage limits exactly like a live POS would.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!invalid) m.mutate(code.trim());
          }}
          noValidate
        >
          <Field label="Coupon code" htmlFor="coupon-code" error={touched && invalid ? "Codes are 4–32 characters" : undefined} className="flex-1">
            <Input id="coupon-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-invalid={touched && invalid} autoComplete="off" className="font-mono" />
          </Field>
          <Button type="submit" loading={m.isPending}>
            Redeem
          </Button>
        </form>
        {m.error ? <GuardrailError error={m.error} className="mt-3" /> : null}
      </CardContent>
    </Card>
  );
}
