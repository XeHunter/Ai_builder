import { zodResolver } from "@hookform/resolvers/zod";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus } from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pagination, Provenance } from "@/components/ui/data";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { FilterChips, GuardrailError, zNum } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn, formatCurrency, formatDateTime, formatPct, titleCase } from "@/lib/utils";
import type { Page } from "@/types/api";

import type { PriceChange } from "../types";
import { invalidatePricing } from "./PriceChangeDrawer";
import { ProductPicker, type PickedProduct } from "./ProductPicker";

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
  { value: "RECOMMENDED", label: "Recommended" },
  { value: "PENDING_APPROVAL", label: "Pending approval" },
  { value: "APPROVED", label: "Approved" },
  { value: "PUBLISHED", label: "Published" },
  { value: "FAILED", label: "Failed" },
  { value: "REJECTED,CANCELLED,EXPIRED", label: "Rejected / cancelled / expired" },
  { value: "", label: "All" },
];

export function PriceChangesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { storeId } = useMerchantStore();
  const { can } = useAuth();
  const [status, setStatus] = React.useState("RECOMMENDED");
  const [source, setSource] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  React.useEffect(() => setPage(1), [status, source, storeId]);

  const q = useQuery({
    queryKey: ["merchant", "pricing", "changes", storeId, status, source, page],
    queryFn: () => api.get<Page<PriceChange>>("/merchant/pricing/changes", { store_id: storeId, status, source, page, page_size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <Callout tone="simulated" title="Publication is simulated">
        <span className="mr-1 inline-flex align-middle">
          <Provenance kind="simulated" />
        </span>
        Approved changes are published through a simulated shelf-label / POS publisher that returns a reference but contacts no device. Recommendations never reach customers until published.
      </Callout>
      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterChips label="Status" options={STATUS_FILTERS} value={status} onChange={setStatus} />
          <div className="flex items-center gap-2">
            <Select aria-label="Filter by source" value={source} onChange={(e) => setSource(e.target.value)} className="w-44">
              <option value="">All sources</option>
              <option value="expiry_markdown">Expiry markdown</option>
              <option value="manual">Manual</option>
            </Select>
            {can("pricing.recommend") && (
              <Button onClick={() => setCreating(true)}>
                <Plus /> New price change
              </Button>
            )}
          </div>
        </div>
        {q.isLoading ? (
          <SkeletonRows rows={6} className="p-3" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-3" />
        ) : !q.data?.items.length ? (
          <EmptyState className="m-3" title="No price changes in this state" description="Expiry evaluation creates markdown recommendations automatically; you can also propose a manual change." />
        ) : (
          <>
            <Table className={cn(q.isPlaceholderData && "opacity-60")}>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Store</TH>
                  <TH>Batch</TH>
                  <TH>Source</TH>
                  <TH className="text-right">Price</TH>
                  <TH className="text-right">Discount</TH>
                  <TH className="text-right">Floor</TH>
                  <TH className="text-right">Margin</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((pc) => (
                  <TR
                    key={pc.id}
                    tabIndex={0}
                    className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => onOpen(pc.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen(pc.id);
                      }
                    }}
                    aria-label={`Open price change for ${pc.product}`}
                  >
                    <TD>
                      <div className="font-medium">{pc.product}</div>
                      <div className="font-mono text-xs text-muted-foreground">{pc.sku}</div>
                    </TD>
                    <TD>
                      <Badge variant="outline">{pc.store_code}</Badge>
                    </TD>
                    <TD className="font-mono text-xs">{pc.batch_code ?? "—"}</TD>
                    <TD className="text-xs">{titleCase(pc.source)}</TD>
                    <TD className="tabular whitespace-nowrap text-right">
                      <span className="text-muted-foreground">{formatCurrency(pc.current_price)}</span>
                      <ArrowRight className="mx-1 inline size-3 text-muted-foreground" aria-label="to" />
                      <span className="font-medium">{formatCurrency(pc.proposed_price)}</span>
                    </TD>
                    <TD className="tabular text-right">{pc.discount_pct > 0 ? `−${pc.discount_pct}%` : "—"}</TD>
                    <TD className="tabular text-right text-muted-foreground">{formatCurrency(pc.floor_price)}</TD>
                    <TD className={cn("tabular text-right", pc.projected_margin_pct < 5 && "text-warning")}>{formatPct(pc.projected_margin_pct, 1)}</TD>
                    <TD>
                      <StatusBadge status={pc.status} />
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(pc.created_at)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="border-t border-border px-3">
              <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />
            </div>
          </>
        )}
      </Card>
      <NewPriceChangeDialog open={creating} onOpenChange={setCreating} onCreated={onOpen} />
    </div>
  );
}

const manualSchema = z.object({
  store_id: z.string().min(1, "Choose a store"),
  product: z.array(z.object({ id: z.string(), name: z.string(), sku: z.string().optional(), price: z.number().optional() })).length(1, "Choose a product"),
  new_price: zNum("Enter the new price").gt(0, "Price must be greater than 0"),
  reason: z.string().trim().min(3, "Explain the change (3+ characters)").max(500),
});

function NewPriceChangeDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const { stores, concreteStoreId } = useMerchantStore();
  const qc = useQueryClient();
  const form = useForm<z.input<typeof manualSchema>, unknown, z.output<typeof manualSchema>>({
    resolver: zodResolver(manualSchema),
    defaultValues: { store_id: concreteStoreId ?? "", product: [], reason: "" },
  });
  React.useEffect(() => {
    if (open) form.reset({ store_id: concreteStoreId ?? "", product: [], reason: "" });
  }, [open, concreteStoreId, form]);
  const m = useMutation({
    mutationFn: (v: z.output<typeof manualSchema>) =>
      api.post<PriceChange>("/merchant/pricing/changes", { store_id: v.store_id, product_id: v.product[0].id, new_price: v.new_price, reason: v.reason }),
    onSuccess: (pc) => {
      invalidatePricing(qc);
      toast.success("Price change proposed", { description: "It needs approval before it is published." });
      onOpenChange(false);
      onCreated(pc.id);
    },
  });
  const picked = form.watch("product") as PickedProduct[];
  const e = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New price change" description="Propose a store-level price. It always goes through approval and guardrail checks before publication." size="lg">
        <form onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate className="space-y-4">
          <Field label="Store" htmlFor="npc-store" error={e.store_id?.message}>
            <Select id="npc-store" {...form.register("store_id")} aria-invalid={!!e.store_id}>
              <option value="">Choose a store</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Product" htmlFor="npc-product" error={e.product?.message}>
            <Controller control={form.control} name="product" render={({ field }) => <ProductPicker id="npc-product" multiple={false} value={field.value as PickedProduct[]} onChange={field.onChange} invalid={!!e.product} />} />
          </Field>
          <Field label="New price (₹)" htmlFor="npc-price" error={e.new_price?.message} hint={picked[0]?.price !== undefined ? `Catalog price ${formatCurrency(picked[0].price)}` : undefined}>
            <Input id="npc-price" type="number" step="0.01" min="0" {...form.register("new_price", { valueAsNumber: true })} aria-invalid={!!e.new_price} />
          </Field>
          <Field label="Reason" htmlFor="npc-reason" error={e.reason?.message}>
            <Textarea id="npc-reason" {...form.register("reason")} maxLength={500} aria-invalid={!!e.reason} />
          </Field>
          <GuardrailError error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={m.isPending}>
              Propose change
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
