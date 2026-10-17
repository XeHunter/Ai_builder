import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import * as React from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input, Label, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/menu";
import { useAuth } from "@/features/auth/auth-context";
import { GuardrailError, zNum, zOptNum } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { titleCase } from "@/lib/utils";

import type { Policy, PricingRule, RuleType } from "../types";

export function RulesPolicyTab() {
  return (
    <div className="space-y-4">
      <Callout title="Pricing guardrails (always enforced)">
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>Automated recommendations never increase prices; only a person can propose a higher price, and it still needs approval.</li>
          <li>No personal or sensitive attributes are used for pricing - prices are per store and batch, never per shopper.</li>
          <li>Price floors (cost, minimum allowed price, minimum margin) and the maximum markdown are enforced at creation, approval and publication.</li>
          <li>Recommendation is separate from publication: changes go RECOMMENDED → approval → PUBLISHED, with every step audited.</li>
        </ul>
      </Callout>
      <div className="grid gap-4 xl:grid-cols-2">
        <PolicyCard />
        <RulesCard />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- policy

const int = (min: number, max: number) => zNum().int("Whole number").min(min, `Min ${min}`).max(max, `Max ${max}`);

export const policySchema = z.object({
  auto_publish_markdowns: z.boolean(),
  auto_publish_max_pct: int(0, 50),
  max_markdown_pct: int(0, 90),
  min_margin_pct: int(-50, 90),
  expiry_warning_days: int(1, 30),
  expiry_critical_hours: int(1, 168),
  sell_by_buffer_hours: int(0, 72),
  forecast_horizon_days: int(1, 60),
  fraud_alert_threshold: int(1, 100),
  default_geofence_radius_m: int(100, 20000),
  notification_cooldown_minutes: int(0, 10080),
  clearance_location_code: z.string().max(32),
});

type PolicyIn = z.input<typeof policySchema>;
type PolicyOut = z.output<typeof policySchema>;

const POLICY_FIELDS: { name: Exclude<keyof PolicyIn, "auto_publish_markdowns" | "clearance_location_code">; label: string; hint: string }[] = [
  { name: "auto_publish_max_pct", label: "Auto-publish up to (%)", hint: "Markdowns at or below this are published without approval (0–50)" },
  { name: "max_markdown_pct", label: "Maximum markdown (%)", hint: "Hard cap on any discount (0–90)" },
  { name: "min_margin_pct", label: "Minimum margin (%)", hint: "Price floor relative to cost (−50–90)" },
  { name: "expiry_warning_days", label: "Expiry warning (days)", hint: "Raise a warning alert this far ahead (1–30)" },
  { name: "expiry_critical_hours", label: "Critical window (hours)", hint: "Critical alert threshold (1–168)" },
  { name: "sell_by_buffer_hours", label: "Sell-by buffer (hours)", hint: "Stop selling this long before expiry (0–72)" },
  { name: "forecast_horizon_days", label: "Forecast horizon (days)", hint: "1–60" },
  { name: "fraud_alert_threshold", label: "Fraud alert threshold", hint: "Risk score that opens an alert (1–100)" },
  { name: "default_geofence_radius_m", label: "Default geofence radius (m)", hint: "100–20000" },
  { name: "notification_cooldown_minutes", label: "Notification cooldown (min)", hint: "0–10080" },
];

export function PolicyCard() {
  const { can } = useAuth();
  const editable = can("settings.manage");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["merchant", "pricing", "policy"], queryFn: () => api.get<Policy>("/merchant/pricing/policy") });
  const form = useForm<PolicyIn, unknown, PolicyOut>({
    resolver: zodResolver(policySchema),
    values: q.data ? { ...q.data, clearance_location_code: q.data.clearance_location_code ?? "" } : undefined,
  });
  const m = useMutation({
    mutationFn: (v: PolicyOut) => {
      const dirty = form.formState.dirtyFields as Partial<Record<keyof PolicyOut, boolean>>;
      const body: Record<string, unknown> = Object.fromEntries(Object.entries(v).filter(([k]) => dirty[k as keyof PolicyOut]));
      if ("clearance_location_code" in body) body.clearance_location_code = (body.clearance_location_code as string).trim() || null;
      return api.patch<Policy>("/merchant/pricing/policy", body);
    },
    onSuccess: (p) => {
      qc.setQueryData(["merchant", "pricing", "policy"], p);
      void qc.invalidateQueries({ queryKey: ["merchant", "expiry"] });
      toast.success("Policy saved");
    },
  });
  const e = form.formState.errors;
  const auto = form.watch("auto_publish_markdowns");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Merchant policy</CardTitle>
        <CardDescription>{editable ? "Changes are audited and take effect on the next evaluation." : "Read-only: editing requires the settings.manage permission."}</CardDescription>
      </CardHeader>
      {q.isLoading ? (
        <CardContent>
          <SkeletonRows rows={6} />
        </CardContent>
      ) : q.isError ? (
        <CardContent>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </CardContent>
      ) : (
        <form onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate>
          <CardContent>
            <fieldset disabled={!editable} className="space-y-4" aria-label="Policy settings">
              <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                <div>
                  <Label htmlFor="pol-auto">Auto-publish small markdowns</Label>
                  <p className="text-xs text-muted-foreground">Off by default. When on, expiry markdowns within the limit below skip manual approval (still guardrail-checked).</p>
                </div>
                <Controller
                  control={form.control}
                  name="auto_publish_markdowns"
                  render={({ field }) => <Switch id="pol-auto" checked={field.value} onCheckedChange={field.onChange} disabled={!editable} aria-label="Auto-publish small markdowns" />}
                />
              </div>
              {auto && <p className="text-xs text-warning">Auto-publish is on: markdowns up to {form.watch("auto_publish_max_pct")}% will publish without a person approving them.</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                {POLICY_FIELDS.map((f) => (
                  <Field key={f.name} label={f.label} htmlFor={`pol-${f.name}`} error={e[f.name]?.message} hint={f.hint}>
                    <Input id={`pol-${f.name}`} type="number" step="1" {...form.register(f.name, { valueAsNumber: true })} aria-invalid={!!e[f.name]} />
                  </Field>
                ))}
                <Field label="Clearance location code" htmlFor="pol-clear" error={e.clearance_location_code?.message} hint="Shelf code of the clearance bin, e.g. CLR-1-1">
                  <Input id="pol-clear" {...form.register("clearance_location_code")} maxLength={32} />
                </Field>
              </div>
            </fieldset>
            <GuardrailError error={m.error} className="mt-3" />
          </CardContent>
          {editable && (
            <CardFooter className="justify-end">
              <Button type="button" variant="ghost" disabled={!form.formState.isDirty || m.isPending} onClick={() => form.reset()}>
                Discard
              </Button>
              <Button type="submit" loading={m.isPending} disabled={!form.formState.isDirty}>
                Save policy
              </Button>
            </CardFooter>
          )}
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- rules

function RulesCard() {
  const { can } = useAuth();
  const { stores } = useMerchantStore();
  const editable = can("settings.manage");
  const q = useQuery({ queryKey: ["merchant", "pricing", "rules"], queryFn: () => api.get<PricingRule[]>("/merchant/pricing/rules") });
  const [editing, setEditing] = React.useState<PricingRule | "new" | null>(null);
  const storeCode = (id: string | null) => (id ? (stores.find((s) => s.id === id)?.code ?? "store") : "All stores");
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Pricing rules</CardTitle>
          <CardDescription>Deterministic, configurable rules that generate recommendations (applied by priority).</CardDescription>
        </div>
        {editable && (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus /> New rule
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <SkeletonRows rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState title="No rules" />
        ) : (
          <ul className="space-y-2">
            {q.data.map((r) => (
              <li key={r.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge variant="outline">{titleCase(r.rule_type)}</Badge>
                    {r.is_active ? <Badge variant="success">Active</Badge> : <Badge>Inactive</Badge>}
                    <Badge>Priority {r.priority}</Badge>
                    <Badge>{storeCode(r.store_id)}</Badge>
                  </div>
                  {editable && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                      <Pencil /> Edit
                    </Button>
                  )}
                </div>
                <RuleSummary rule={r} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing === "new" ? "New pricing rule" : `Edit ${editing?.name ?? "rule"}`} size="lg">
          {editing !== null && <RuleForm rule={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RuleSummary({ rule }: { rule: PricingRule }) {
  const p = rule.parameters as { elasticity?: number; tiers?: { max_hours: number; max_discount_pct: number }[]; product_tag?: string; discount_pct?: number; min_precip_mm?: number };
  if (rule.rule_type === "expiry_markdown") {
    return (
      <div className="mt-2 text-xs text-muted-foreground">
        <p>Elasticity assumption {p.elasticity ?? 2.0} (heuristic)</p>
        {p.tiers && (
          <div className="mt-1 flex flex-wrap gap-1">
            {p.tiers.map((t) => (
              <Badge key={t.max_hours} variant="info">
                ≤ {t.max_hours} h: up to {t.max_discount_pct}%
              </Badge>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (rule.rule_type === "weather_promotion") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Products tagged “{p.product_tag ?? "rain"}” · {p.discount_pct ?? 10}% off · when ≥ {p.min_precip_mm ?? 5} mm rain is forecast
      </p>
    );
  }
  return <p className="mt-2 font-mono text-xs text-muted-foreground">{JSON.stringify(rule.parameters)}</p>;
}

const jsonObject = (label: string) =>
  z.string().refine((s) => {
    if (!s.trim()) return true;
    try {
      const v = JSON.parse(s);
      return typeof v === "object" && v !== null && !Array.isArray(v);
    } catch {
      return false;
    }
  }, `${label} must be a JSON object`);

export const ruleSchema = z
  .object({
    name: z.string().trim().min(2, "At least 2 characters").max(120),
    store_id: z.string(),
    rule_type: z.enum(["expiry_markdown", "weather_promotion", "overstock_clearance"]),
    is_active: z.boolean(),
    priority: zNum().int("Whole number").min(0, "Min 0").max(1000, "Max 1000"),
    conditions_json: jsonObject("Conditions"),
    elasticity: zOptNum(z.number().min(0.1, "Between 0.1 and 10").max(10, "Between 0.1 and 10")),
    tiers: z.array(z.object({ max_hours: zNum().int("Whole hours").min(1, "1–720").max(720, "1–720"), max_discount_pct: zNum().min(0, "0–90").max(90, "0–90") })),
    product_tag: z.string().max(40),
    discount_pct: zOptNum(z.number().min(1, "Between 1 and 50").max(50, "Between 1 and 50")),
    min_precip_mm: zOptNum(z.number().min(0, "Cannot be negative").max(500)),
    params_json: jsonObject("Parameters"),
  })
  .superRefine((v, ctx) => {
    if (v.rule_type === "weather_promotion" && !v.product_tag.trim()) ctx.addIssue({ code: "custom", path: ["product_tag"], message: "Product tag is required" });
  });

type RuleIn = z.input<typeof ruleSchema>;
type RuleOut = z.output<typeof ruleSchema>;

const STRUCTURED: Record<RuleType, string[]> = {
  expiry_markdown: ["elasticity", "tiers"],
  weather_promotion: ["product_tag", "discount_pct", "min_precip_mm"],
  overstock_clearance: [],
};

function ruleDefaults(rule: PricingRule | null): RuleIn {
  const p = (rule?.parameters ?? {}) as Record<string, unknown>;
  const type = rule?.rule_type ?? "expiry_markdown";
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !STRUCTURED[type].includes(k)));
  return {
    name: rule?.name ?? "",
    store_id: rule?.store_id ?? "",
    rule_type: type,
    is_active: rule?.is_active ?? true,
    priority: rule?.priority ?? 100,
    conditions_json: JSON.stringify(rule?.conditions ?? {}, null, 2),
    elasticity: (p.elasticity as number | undefined) ?? 2,
    tiers: (p.tiers as { max_hours: number; max_discount_pct: number }[] | undefined) ?? [
      { max_hours: 24, max_discount_pct: 50 },
      { max_hours: 48, max_discount_pct: 30 },
    ],
    product_tag: (p.product_tag as string | undefined) ?? "rain",
    discount_pct: (p.discount_pct as number | undefined) ?? 10,
    min_precip_mm: (p.min_precip_mm as number | undefined) ?? 5,
    params_json: JSON.stringify(rest, null, 2),
  };
}

function buildParameters(v: RuleOut): Record<string, unknown> {
  const extra = v.params_json.trim() ? (JSON.parse(v.params_json) as Record<string, unknown>) : {};
  if (v.rule_type === "expiry_markdown") {
    return { ...extra, elasticity: v.elasticity ?? 2, tiers: [...v.tiers].sort((a, b) => a.max_hours - b.max_hours) };
  }
  if (v.rule_type === "weather_promotion") {
    return { ...extra, product_tag: v.product_tag.trim(), discount_pct: v.discount_pct ?? 10, min_precip_mm: v.min_precip_mm ?? 5 };
  }
  return extra;
}

function RuleForm({ rule, onDone }: { rule: PricingRule | null; onDone: () => void }) {
  const { stores } = useMerchantStore();
  const qc = useQueryClient();
  const form = useForm<RuleIn, unknown, RuleOut>({ resolver: zodResolver(ruleSchema), defaultValues: ruleDefaults(rule) });
  const tiers = useFieldArray({ control: form.control, name: "tiers" });
  const type = form.watch("rule_type");
  const m = useMutation({
    mutationFn: (v: RuleOut) => {
      const body = {
        name: v.name,
        store_id: v.store_id || null,
        rule_type: v.rule_type,
        is_active: v.is_active,
        priority: v.priority,
        conditions: v.conditions_json.trim() ? JSON.parse(v.conditions_json) : {},
        parameters: buildParameters(v),
      };
      return rule ? api.put<PricingRule>(`/merchant/pricing/rules/${rule.id}`, body) : api.post<PricingRule>("/merchant/pricing/rules", body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["merchant", "pricing"] });
      toast.success(rule ? `Saved ${r.name}` : `Created ${r.name}`);
      onDone();
    },
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="rule-name" error={e.name?.message}>
          <Input id="rule-name" {...form.register("name")} aria-invalid={!!e.name} />
        </Field>
        <Field label="Rule type" htmlFor="rule-type">
          <Select id="rule-type" {...form.register("rule_type")}>
            <option value="expiry_markdown">Expiry markdown</option>
            <option value="weather_promotion">Weather promotion</option>
            <option value="overstock_clearance">Overstock clearance</option>
          </Select>
        </Field>
        <Field label="Store" htmlFor="rule-store">
          <Select id="rule-store" {...form.register("store_id")}>
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="rule-prio" error={e.priority?.message} hint="Lower runs first (0–1000)">
          <Input id="rule-prio" type="number" step="1" {...form.register("priority", { valueAsNumber: true })} aria-invalid={!!e.priority} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Controller control={form.control} name="is_active" render={({ field }) => <Switch id="rule-active" checked={field.value} onCheckedChange={field.onChange} />} />
        <Label htmlFor="rule-active">Active</Label>
      </div>

      {type === "expiry_markdown" && (
        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">Markdown ladder</legend>
          <Field label="Price elasticity assumption" htmlFor="rule-elast" error={e.elasticity?.message} hint="Heuristic: how much demand rises per unit of discount (0.1–10)">
            <Input id="rule-elast" type="number" step="0.1" {...form.register("elasticity", { valueAsNumber: true })} aria-invalid={!!e.elasticity} />
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium">Tiers</p>
            {tiers.fields.map((t, i) => (
              <div key={t.id} className="flex items-end gap-2">
                <Field label="Within hours" htmlFor={`tier-h-${i}`} error={e.tiers?.[i]?.max_hours?.message} className="flex-1">
                  <Input id={`tier-h-${i}`} type="number" step="1" {...form.register(`tiers.${i}.max_hours`, { valueAsNumber: true })} />
                </Field>
                <Field label="Max discount %" htmlFor={`tier-d-${i}`} error={e.tiers?.[i]?.max_discount_pct?.message} className="flex-1">
                  <Input id={`tier-d-${i}`} type="number" step="1" {...form.register(`tiers.${i}.max_discount_pct`, { valueAsNumber: true })} />
                </Field>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove tier ${i + 1}`} onClick={() => tiers.remove(i)}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => tiers.append({ max_hours: 72, max_discount_pct: 20 })}>
              <Plus /> Add tier
            </Button>
          </div>
        </fieldset>
      )}
      {type === "weather_promotion" && (
        <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Weather trigger</legend>
          <Field label="Product tag" htmlFor="rule-tag" error={e.product_tag?.message}>
            <Input id="rule-tag" {...form.register("product_tag")} />
          </Field>
          <Field label="Discount %" htmlFor="rule-disc" error={e.discount_pct?.message} hint="1–50">
            <Input id="rule-disc" type="number" step="1" {...form.register("discount_pct", { valueAsNumber: true })} />
          </Field>
          <Field label="Min rain (mm)" htmlFor="rule-mm" error={e.min_precip_mm?.message}>
            <Input id="rule-mm" type="number" step="0.5" {...form.register("min_precip_mm", { valueAsNumber: true })} />
          </Field>
        </fieldset>
      )}
      <Field label={type === "overstock_clearance" ? "Parameters (JSON)" : "Additional parameters (JSON)"} htmlFor="rule-params" error={e.params_json?.message}>
        <Textarea id="rule-params" rows={3} className="font-mono text-xs" {...form.register("params_json")} aria-invalid={!!e.params_json} />
      </Field>
      <Field label="Conditions (JSON)" htmlFor="rule-cond" error={e.conditions_json?.message}>
        <Textarea id="rule-cond" rows={3} className="font-mono text-xs" {...form.register("conditions_json")} aria-invalid={!!e.conditions_json} />
      </Field>
      <GuardrailError error={m.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={m.isPending}>
          <ShieldCheck /> {rule ? "Save rule" : "Create rule"}
        </Button>
      </DialogFooter>
    </form>
  );
}
