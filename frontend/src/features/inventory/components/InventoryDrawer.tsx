import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue } from "@/components/ui/data";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { GuardrailError, zNum } from "@/features/merchant-dashboard/components/common";
import { api } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatDateTime, formatNumber, titleCase } from "@/lib/utils";

import type { Batch, InventoryDetail } from "../types";

export const ADJUST_REASONS = ["receive", "count_correction", "damage", "manual", "return"] as const;

/** Adjustment form schema. `available` is the sellable quantity (whole item, or the chosen batch). */
export function makeAdjustSchema(ctx: { onHand: number; batches: Pick<Batch, "id" | "quantity_remaining">[] }) {
  return z
    .object({
      delta: zNum("Enter a quantity change").int("Whole units only").refine((v) => v !== 0, "Change cannot be zero").refine((v) => Math.abs(v) <= 100000, "Too large"),
      reason: z.enum(ADJUST_REASONS),
      note: z.string().max(255).optional(),
      batch_id: z.string().optional(),
      batch_code: z.string().max(64).optional(),
      expiry_date: z.string().optional(),
    })
    .superRefine((v, c) => {
      if (Number.isNaN(v.delta)) return;
      if (v.reason === "receive" && v.delta < 0) c.addIssue({ code: "custom", path: ["delta"], message: "Receiving must add stock (positive number)" });
      if (v.reason === "damage" && v.delta > 0) c.addIssue({ code: "custom", path: ["delta"], message: "Damage removes stock (negative number)" });
      if (v.delta < 0) {
        const available = v.batch_id ? (ctx.batches.find((b) => b.id === v.batch_id)?.quantity_remaining ?? 0) : ctx.onHand;
        if (-v.delta > available) c.addIssue({ code: "custom", path: ["delta"], message: `Only ${available} units available to remove` });
      }
    });
}

type AdjustIn = z.input<ReturnType<typeof makeAdjustSchema>>;
type AdjustOut = z.output<ReturnType<typeof makeAdjustSchema>>;

const settingsSchema = z.object({
  reorder_point: zNum().int("Whole units").min(0, "Cannot be negative").max(100000),
  reorder_quantity: zNum().int("Whole units").min(1, "At least 1").max(100000),
});

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["merchant", "inventory"] });
  void qc.invalidateQueries({ queryKey: ["merchant", "catalog"] });
  void qc.invalidateQueries({ queryKey: ["merchant", "expiry"] });
  void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
}

export function InventoryDrawer({ itemId, onClose }: { itemId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["merchant", "inventory", "item", itemId],
    queryFn: () => api.get<InventoryDetail>(`/merchant/inventory/items/${itemId}`),
    enabled: Boolean(itemId),
  });
  const d = q.data;
  return (
    <Dialog open={Boolean(itemId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent side="right" size="xl" title={d ? d.name : "Inventory item"} description={d ? `${d.sku} · store ${d.store_code}` : undefined}>
        {q.isLoading ? (
          <SkeletonRows rows={6} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : d ? (
          <ItemDetail item={d} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ItemDetail({ item }: { item: InventoryDetail }) {
  const { can } = useAuth();
  const canWrite = can("inventory.write");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.stock_status} />
        {item.is_perishable && <Badge variant="warning">Perishable</Badge>}
        {item.shelf_code ? <Badge variant="outline">Shelf {item.shelf_code}</Badge> : <Badge>No shelf placement</Badge>}
      </div>
      <KeyValue
        items={[
          ["On hand", `${formatNumber(item.quantity_on_hand)} units`],
          ["Reorder point / quantity", `${item.reorder_point} / ${item.reorder_quantity}`],
          ["Shelf price", formatCurrency(item.price)],
          ["Category", item.category ?? "—"],
          ["Next expiry", formatDate(item.next_expiry, { year: "numeric" })],
        ]}
      />

      <section aria-labelledby="batches-h">
        <h3 id="batches-h" className="mb-2 text-sm font-semibold">
          Batches
        </h3>
        {item.batches.length === 0 ? (
          <EmptyState title="No batches" description="Receive stock to create the first batch." />
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <THead>
                <TR>
                  <TH>Batch</TH>
                  <TH>Expiry</TH>
                  <TH className="text-right">Days left</TH>
                  <TH className="text-right">Remaining / received</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Markdown</TH>
                </TR>
              </THead>
              <TBody>
                {item.batches.map((b) => (
                  <TR key={b.id}>
                    <TD className="font-mono text-xs">{b.batch_code}</TD>
                    <TD>{formatDate(b.expiry_date, { year: "numeric" })}</TD>
                    <TD className={cn("tabular text-right", b.days_to_expiry !== null && b.days_to_expiry <= 2 && "font-medium text-danger")}>{b.days_to_expiry ?? "—"}</TD>
                    <TD className="tabular text-right">
                      {b.quantity_remaining} / {b.quantity_received}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        <StatusBadge status={b.status} />
                        {b.in_clearance && <Badge variant="accent">Clearance</Badge>}
                      </div>
                    </TD>
                    <TD className="tabular text-right">{b.markdown_price !== null ? `${formatCurrency(b.markdown_price)}${b.markdown_pct ? ` (−${b.markdown_pct}%)` : ""}` : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </section>

      {canWrite ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <AdjustForm item={item} />
          <ReorderForm item={item} />
        </div>
      ) : (
        <Callout>You have read-only access to inventory. Stock adjustments require the inventory.write permission.</Callout>
      )}

      <section aria-labelledby="ledger-h">
        <h3 id="ledger-h" className="mb-2 text-sm font-semibold">
          Adjustment ledger
        </h3>
        {item.adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No adjustments recorded yet.</p>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Who</TH>
                  <TH>Why</TH>
                  <TH className="text-right">Δ</TH>
                  <TH className="text-right">After</TH>
                </TR>
              </THead>
              <TBody>
                {item.adjustments.map((a) => (
                  <TR key={a.id}>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(a.created_at)}</TD>
                    <TD className="text-xs">{a.actor}</TD>
                    <TD className="text-xs">
                      <span className="font-medium">{titleCase(a.reason)}</span>
                      {a.note && <span className="block text-muted-foreground">{a.note}</span>}
                    </TD>
                    <TD className={cn("tabular text-right font-medium", a.delta > 0 ? "text-success" : "text-danger")}>
                      <span className="inline-flex items-center gap-0.5">
                        {a.delta > 0 ? <ArrowUpRight className="size-3" aria-hidden /> : <ArrowDownRight className="size-3" aria-hidden />}
                        {a.delta > 0 ? `+${a.delta}` : a.delta}
                      </span>
                    </TD>
                    <TD className="tabular text-right">{a.quantity_after}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

export function AdjustForm({ item }: { item: InventoryDetail }) {
  const qc = useQueryClient();
  const sellable = item.batches.filter((b) => b.quantity_remaining > 0 && !["expired", "withdrawn"].includes(b.status));
  const schema = makeAdjustSchema({ onHand: item.quantity_on_hand, batches: item.batches });
  const form = useForm<AdjustIn, unknown, AdjustOut>({ resolver: zodResolver(schema), defaultValues: { reason: "receive", note: "", batch_id: "", batch_code: "", expiry_date: "" } });
  const delta = form.watch("delta") as number | undefined;
  const batchId = form.watch("batch_id");
  const receiving = typeof delta === "number" && delta > 0 && !batchId;
  const removing = typeof delta === "number" && delta < 0 && !batchId;
  const m = useMutation({
    mutationFn: (v: AdjustOut) =>
      api.post<InventoryDetail>(`/merchant/inventory/items/${item.id}/adjust`, {
        delta: v.delta,
        reason: v.reason,
        note: v.note?.trim() || null,
        batch_id: v.batch_id || null,
        ...(v.delta > 0 && !v.batch_id ? { batch_code: v.batch_code?.trim() || null, expiry_date: v.expiry_date || null } : {}),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["merchant", "inventory", "item", item.id], d);
      invalidateAll(qc);
      toast.success(`Stock updated: ${d.quantity_on_hand} on hand`);
      form.reset({ reason: form.getValues("reason"), note: "", batch_id: "", batch_code: "", expiry_date: "", delta: undefined as unknown as number });
    },
  });
  const e = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Adjust stock</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Change (+/−)" htmlFor="adj-delta" error={e.delta?.message} hint="e.g. 24 or -3">
              <Input id="adj-delta" type="number" step="1" {...form.register("delta", { valueAsNumber: true })} aria-invalid={!!e.delta} />
            </Field>
            <Field label="Reason" htmlFor="adj-reason" error={e.reason?.message}>
              <Select id="adj-reason" {...form.register("reason")}>
                {ADJUST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {titleCase(r)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Batch (optional)" htmlFor="adj-batch" hint="Leave empty to receive a new batch or remove first-expiry-first-out">
            <Select id="adj-batch" {...form.register("batch_id")}>
              <option value="">Automatic (new batch / FEFO)</option>
              {sellable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batch_code} · {b.quantity_remaining} left{b.expiry_date ? ` · exp ${formatDate(b.expiry_date)}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          {receiving && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Batch code" htmlFor="adj-code" hint="Optional; generated if empty">
                <Input id="adj-code" {...form.register("batch_code")} maxLength={64} />
              </Field>
              <Field label="Expiry date" htmlFor="adj-exp" hint={item.is_perishable ? "Recommended for perishables" : "Optional"}>
                <Input id="adj-exp" type="date" {...form.register("expiry_date")} />
              </Field>
            </div>
          )}
          {removing && <p className="text-xs text-muted-foreground">Removals without a batch are taken first-expiry-first-out (FEFO): the earliest-expiring batches are reduced first.</p>}
          <Field label="Note" htmlFor="adj-note">
            <Input id="adj-note" {...form.register("note")} maxLength={255} placeholder="e.g. delivery #4411, broken packs" />
          </Field>
          <GuardrailError error={m.error} />
          <Button type="submit" loading={m.isPending} className="w-full">
            Apply adjustment
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ReorderForm({ item }: { item: InventoryDetail }) {
  const qc = useQueryClient();
  const form = useForm<z.input<typeof settingsSchema>, unknown, z.output<typeof settingsSchema>>({
    resolver: zodResolver(settingsSchema),
    values: { reorder_point: item.reorder_point, reorder_quantity: item.reorder_quantity },
  });
  const m = useMutation({
    mutationFn: (v: z.output<typeof settingsSchema>) => api.patch<InventoryDetail>(`/merchant/inventory/items/${item.id}`, v),
    onSuccess: (d) => {
      qc.setQueryData(["merchant", "inventory", "item", item.id], d);
      invalidateAll(qc);
      toast.success("Reorder settings saved");
    },
  });
  const e = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reorder settings</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate className="space-y-3">
          <Field label="Reorder point" htmlFor="ro-point" error={e.reorder_point?.message} hint="Low-stock when on hand is at or below this">
            <Input id="ro-point" type="number" min="0" step="1" {...form.register("reorder_point", { valueAsNumber: true })} aria-invalid={!!e.reorder_point} />
          </Field>
          <Field label="Reorder quantity" htmlFor="ro-qty" error={e.reorder_quantity?.message}>
            <Input id="ro-qty" type="number" min="1" step="1" {...form.register("reorder_quantity", { valueAsNumber: true })} aria-invalid={!!e.reorder_quantity} />
          </Field>
          <GuardrailError error={m.error} />
          <Button type="submit" variant="outline" loading={m.isPending} disabled={!form.formState.isDirty} className="w-full">
            Save settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
