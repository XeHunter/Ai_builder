import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { GuardrailError, zNum, zOptNum } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn, formatCurrency, formatNumber, titleCase } from "@/lib/utils";

import type { Promotion, PromotionPayload, SimulationResult } from "../types";
import { ProductPicker, type PickedProduct } from "./ProductPicker";

export const promotionSchema = z
  .object({
    name: z.string().trim().min(3, "Name must be at least 3 characters").max(120),
    description: z.string().max(1000).optional(),
    store_id: z.string(),
    products: z.array(z.object({ id: z.string(), name: z.string(), sku: z.string().optional(), price: z.number().optional() })).min(1, "Add at least one product").max(100, "At most 100 products"),
    promo_type: z.enum(["percent_off", "amount_off"]),
    discount_value: zNum("Enter the discount").gt(0, "Discount must be greater than 0"),
    starts_at: z.string().min(1, "Choose a start time"),
    ends_at: z.string().min(1, "Choose an end time"),
    usage_limit: zOptNum(z.number().int("Whole number").min(1, "At least 1").max(1_000_000)),
    per_customer_limit: zNum("Enter a limit").int("Whole number").min(1, "At least 1").max(10, "At most 10"),
    geofence_radius_m: zOptNum(z.number().int("Whole metres").min(100, "At least 100 m").max(20000, "At most 20 km")),
  })
  .superRefine((v, ctx) => {
    if (v.starts_at && v.ends_at && new Date(v.ends_at).getTime() <= new Date(v.starts_at).getTime()) {
      ctx.addIssue({ code: "custom", path: ["ends_at"], message: "End must be after the start" });
    }
    if (v.promo_type === "percent_off" && !Number.isNaN(v.discount_value) && v.discount_value >= 100) {
      ctx.addIssue({ code: "custom", path: ["discount_value"], message: "Percentage must be below 100" });
    }
  });

export type PromotionFormIn = z.input<typeof promotionSchema>;
export type PromotionFormOut = z.output<typeof promotionSchema>;

/** Format a Date for a datetime-local input (local time, minutes precision). */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface PromotionPrefill {
  name?: string;
  description?: string;
  store_id?: string | null;
  products?: PickedProduct[];
  promo_type?: "percent_off" | "amount_off";
  discount_value?: number;
  starts_at?: string;
  ends_at?: string;
  geofence_radius_m?: number | null;
  trigger?: PromotionPayload["trigger"];
  evidence?: Record<string, unknown>;
}

function toPayload(v: PromotionFormOut, prefill?: PromotionPrefill): PromotionPayload {
  return {
    name: v.name,
    description: v.description ?? "",
    store_id: v.store_id || null,
    product_ids: v.products.map((p) => p.id),
    promo_type: v.promo_type,
    discount_value: v.discount_value,
    starts_at: new Date(v.starts_at).toISOString(),
    ends_at: new Date(v.ends_at).toISOString(),
    usage_limit: v.usage_limit ?? null,
    per_customer_limit: v.per_customer_limit,
    geofence_radius_m: v.geofence_radius_m ?? null,
    trigger: prefill?.trigger ?? "manual",
    evidence: prefill?.evidence ?? {},
  };
}

function defaults(prefill?: PromotionPrefill): PromotionFormIn {
  const now = new Date();
  const start = new Date(now.getTime() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    name: prefill?.name ?? "",
    description: prefill?.description ?? "",
    store_id: prefill?.store_id ?? "",
    products: prefill?.products ?? [],
    promo_type: prefill?.promo_type ?? "percent_off",
    discount_value: prefill?.discount_value ?? 10,
    starts_at: prefill?.starts_at ? toLocalInput(new Date(prefill.starts_at)) : toLocalInput(start),
    ends_at: prefill?.ends_at ? toLocalInput(new Date(prefill.ends_at)) : toLocalInput(end),
    usage_limit: undefined,
    per_customer_limit: 1,
    geofence_radius_m: prefill?.geofence_radius_m ?? undefined,
  };
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefill?: PromotionPrefill;
  onCreated?: (p: Promotion) => void;
}

export function PromotionFormDialog({ open, onOpenChange, prefill, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={prefill?.trigger === "weather" ? "New weather promotion draft" : "New promotion"} description="Creates a draft. Guardrails are checked now and again at approval; nothing goes live until approved." size="xl">
        {open && <PromotionForm prefill={prefill} onCancel={() => onOpenChange(false)} onCreated={(p) => { onOpenChange(false); onCreated?.(p); }} />}
      </DialogContent>
    </Dialog>
  );
}

export function PromotionForm({ prefill, onCancel, onCreated }: { prefill?: PromotionPrefill; onCancel: () => void; onCreated: (p: Promotion) => void }) {
  const { stores } = useMerchantStore();
  const qc = useQueryClient();
  const form = useForm<PromotionFormIn, unknown, PromotionFormOut>({ resolver: zodResolver(promotionSchema), defaultValues: defaults(prefill) });
  const [sim, setSim] = React.useState<SimulationResult | null>(null);

  const simulate = useMutation({
    mutationFn: (v: PromotionFormOut) => api.post<SimulationResult>("/merchant/promotions/simulate", toPayload(v, prefill)),
    onSuccess: setSim,
  });
  const create = useMutation({
    mutationFn: (v: PromotionFormOut) => api.post<Promotion>("/merchant/promotions", toPayload(v, prefill)),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["merchant", "pricing"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
      toast.success(`Draft "${p.name}" created`, { description: "Submit it for approval to schedule it." });
      onCreated(p);
    },
  });
  const promoType = form.watch("promo_type");
  const e = form.formState.errors;

  return (
    <form onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate className="space-y-4">
      {prefill?.trigger === "weather" && (
        <Callout tone="info" title="Prefilled from weather opportunity">
          Products sold more on past rainy days at this store - an association, not proven causation. The draft still needs approval.
        </Callout>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="pr-name" error={e.name?.message}>
          <Input id="pr-name" {...form.register("name")} aria-invalid={!!e.name} />
        </Field>
        <Field label="Store" htmlFor="pr-store">
          <Select id="pr-store" {...form.register("store_id")}>
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" htmlFor="pr-desc" className="sm:col-span-2">
          <Textarea id="pr-desc" rows={2} {...form.register("description")} maxLength={1000} />
        </Field>
        <Field label="Products" htmlFor="pr-products" error={e.products?.message ?? e.products?.root?.message} className="sm:col-span-2">
          <Controller control={form.control} name="products" render={({ field }) => <ProductPicker id="pr-products" value={field.value as PickedProduct[]} onChange={field.onChange} invalid={!!e.products} />} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Discount type" htmlFor="pr-type">
            <Select id="pr-type" {...form.register("promo_type")}>
              <option value="percent_off">Percent off</option>
              <option value="amount_off">Amount off (₹)</option>
            </Select>
          </Field>
          <Field label={promoType === "percent_off" ? "Discount (%)" : "Discount (₹)"} htmlFor="pr-value" error={e.discount_value?.message}>
            <Input id="pr-value" type="number" step="0.01" min="0" {...form.register("discount_value", { valueAsNumber: true })} aria-invalid={!!e.discount_value} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Usage limit" htmlFor="pr-usage" error={e.usage_limit?.message} hint="Optional total redemptions">
            <Input id="pr-usage" type="number" min="1" step="1" {...form.register("usage_limit", { valueAsNumber: true })} aria-invalid={!!e.usage_limit} />
          </Field>
          <Field label="Per customer" htmlFor="pr-percust" error={e.per_customer_limit?.message}>
            <Input id="pr-percust" type="number" min="1" max="10" step="1" {...form.register("per_customer_limit", { valueAsNumber: true })} aria-invalid={!!e.per_customer_limit} />
          </Field>
        </div>
        <Field label="Starts" htmlFor="pr-start" error={e.starts_at?.message}>
          <Input id="pr-start" type="datetime-local" {...form.register("starts_at")} aria-invalid={!!e.starts_at} />
        </Field>
        <Field label="Ends" htmlFor="pr-end" error={e.ends_at?.message}>
          <Input id="pr-end" type="datetime-local" {...form.register("ends_at")} aria-invalid={!!e.ends_at} />
        </Field>
        <Field label="Geofence radius (m)" htmlFor="pr-geo" error={e.geofence_radius_m?.message} hint="Optional: only offered to shoppers near the store (100–20000 m)">
          <Input id="pr-geo" type="number" min="100" max="20000" step="50" {...form.register("geofence_radius_m", { valueAsNumber: true })} aria-invalid={!!e.geofence_radius_m} />
        </Field>
      </div>

      {simulate.error ? <GuardrailError error={simulate.error} /> : null}
      {sim && <SimulationView sim={sim} />}
      <GuardrailError error={create.error} />

      <DialogFooter className="flex-wrap">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" loading={simulate.isPending} onClick={form.handleSubmit((v) => simulate.mutate(v))}>
          <FlaskConical /> Simulate
        </Button>
        <Button type="submit" loading={create.isPending}>
          Create draft
        </Button>
      </DialogFooter>
    </form>
  );
}

function SimulationView({ sim }: { sim: SimulationResult }) {
  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Simulation result">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Simulation ({sim.window_days} days)</h3>
        {sim.valid ? <Badge variant="success">Passes guardrails</Badge> : <Badge variant="danger">Guardrail issues</Badge>}
        <Badge>{titleCase(sim.method)}</Badge>
      </div>
      {sim.issues.length > 0 && (
        <ul className="space-y-1 rounded-md bg-danger-soft p-3 text-sm">
          {sim.issues.map((i) => (
            <li key={i.product_id}>
              <span className="font-medium">{i.name}</span> <span className="text-muted-foreground">({i.sku}; promo {formatCurrency(i.promo_price)}, floor {formatCurrency(i.floor_price)})</span>: {i.problems.join(" ")}
            </li>
          ))}
        </ul>
      )}
      {sim.lines.length > 0 && (
        <div className="rounded-md border border-border">
          <Table>
            <THead>
              <TR>
                <TH>Product</TH>
                <TH className="text-right">Regular → promo</TH>
                <TH className="text-right">Baseline units</TH>
                <TH className="text-right">Margin (regular)</TH>
                <TH className="text-right">Margin (promo, same volume)</TH>
                <TH className="text-right">Break-even volume</TH>
              </TR>
            </THead>
            <TBody>
              {sim.lines.map((l) => (
                <TR key={l.product_id}>
                  <TD className="font-medium">{l.name}</TD>
                  <TD className="tabular whitespace-nowrap text-right">
                    {formatCurrency(l.regular_price)} → {formatCurrency(l.promo_price)}
                  </TD>
                  <TD className="tabular text-right">{formatNumber(l.baseline_units, 1)}</TD>
                  <TD className="tabular text-right">{formatCurrency(l.margin_regular)}</TD>
                  <TD className={cn("tabular text-right", l.margin_at_promo_same_volume < l.margin_regular && "text-warning")}>{formatCurrency(l.margin_at_promo_same_volume)}</TD>
                  <TD className="tabular text-right">{l.breakeven_volume_increase_pct === null ? <span className="text-danger">below cost</span> : `+${l.breakeven_volume_increase_pct}%`}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{sim.caveat}</p>
    </section>
  );
}
