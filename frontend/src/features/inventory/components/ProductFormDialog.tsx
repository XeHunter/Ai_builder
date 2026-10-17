import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { GuardrailError, zNum, zOptNum } from "@/features/merchant-dashboard/components/common";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

import type { AdminProduct, MerchantCategory } from "../types";

const base = {
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(160),
  description: z.string().max(2000).optional(),
  category_id: z.string().optional(),
  brand: z.string().max(80).optional(),
  unit: z.string().trim().min(1, "Unit is required").max(32),
  cost_price: zNum("Enter the unit cost").min(0, "Cost cannot be negative"),
  min_allowed_price: zOptNum(z.number().min(0, "Cannot be negative")),
  target_segment: z.string().max(64).optional(),
  promotion_eligible: z.boolean(),
  is_perishable: z.boolean(),
  is_child_product: z.boolean(),
  weight_kg: zOptNum(z.number().min(0, "Cannot be negative").max(500, "Max 500 kg")),
  tags: z.string().optional(),
};

export const createProductSchema = z
  .object({
    sku: z.string().trim().min(1, "SKU is required").max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_\-.]*$/, "Letters, digits, - _ . only; must start with a letter or digit"),
    price: zNum("Enter a selling price").gt(0, "Price must be greater than 0"),
    ...base,
  })
  .refine((v) => v.min_allowed_price === undefined || v.min_allowed_price <= v.price, {
    path: ["min_allowed_price"],
    message: "Minimum price cannot exceed the selling price",
  });

const editProductSchema = z.object({ ...base, status: z.enum(["active", "archived"]) });

type CreateValues = z.input<typeof createProductSchema>;
type EditValues = z.input<typeof editProductSchema>;

function parseTags(s?: string): string[] {
  return (s ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 20);
}

const blankToNull = (s?: string) => (s && s.trim() ? s.trim() : null);

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  categories: MerchantCategory[];
  /** Edit mode when a product is given. */
  product?: AdminProduct | null;
}

export function ProductFormDialog({ open, onOpenChange, categories, product }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={product ? `Edit ${product.sku}` : "New product"}
        description={product ? product.name : "Add a product to the catalog. Stock is added through inventory receipts or imports."}
        size="lg"
      >
        {open && (product ? <EditForm product={product} categories={categories} onDone={() => onOpenChange(false)} /> : <CreateForm categories={categories} onDone={() => onOpenChange(false)} />)}
      </DialogContent>
    </Dialog>
  );
}

function useInvalidateCatalog() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["merchant", "catalog"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "inventory"] });
    void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
  };
}

function CreateForm({ categories, onDone }: { categories: MerchantCategory[]; onDone: () => void }) {
  const invalidate = useInvalidateCatalog();
  const form = useForm<CreateValues, unknown, z.output<typeof createProductSchema>>({
    resolver: zodResolver(createProductSchema),
    defaultValues: { sku: "", name: "", unit: "each", promotion_eligible: true, is_perishable: false, is_child_product: false, tags: "" },
  });
  const m = useMutation({
    mutationFn: (v: z.output<typeof createProductSchema>) =>
      api.post<AdminProduct>("/merchant/products", {
        sku: v.sku,
        name: v.name,
        description: v.description ?? "",
        category_id: v.category_id || null,
        brand: blankToNull(v.brand),
        unit: v.unit,
        price: v.price,
        cost_price: v.cost_price,
        min_allowed_price: v.min_allowed_price ?? null,
        target_segment: blankToNull(v.target_segment),
        promotion_eligible: v.promotion_eligible,
        is_perishable: v.is_perishable,
        is_child_product: v.is_child_product,
        weight_kg: v.weight_kg ?? null,
        tags: parseTags(v.tags),
      }),
    onSuccess: (p) => {
      toast.success(`Created ${p.sku}`, { description: "Search index refresh has been queued." });
      invalidate();
      onDone();
    },
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SKU" htmlFor="pf-sku" error={e.sku?.message} hint="Stored in upper case">
          <Input id="pf-sku" {...form.register("sku")} aria-invalid={!!e.sku} autoComplete="off" />
        </Field>
        <Field label="Name" htmlFor="pf-name" error={e.name?.message}>
          <Input id="pf-name" {...form.register("name")} aria-invalid={!!e.name} />
        </Field>
        <Field label="Selling price (₹)" htmlFor="pf-price" error={e.price?.message}>
          <Input id="pf-price" type="number" step="0.01" min="0" {...form.register("price", { valueAsNumber: true })} aria-invalid={!!e.price} />
        </Field>
        <SharedFields form={form as never} categories={categories} />
      </div>
      <GuardrailError error={m.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={m.isPending}>
          Create product
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditForm({ product, categories, onDone }: { product: AdminProduct; categories: MerchantCategory[]; onDone: () => void }) {
  const invalidate = useInvalidateCatalog();
  const form = useForm<EditValues, unknown, z.output<typeof editProductSchema>>({
    resolver: zodResolver(editProductSchema),
    defaultValues: {
      name: product.name,
      description: product.description,
      category_id: product.category_id ?? "",
      brand: product.brand ?? "",
      unit: product.unit,
      cost_price: product.cost_price,
      min_allowed_price: product.min_allowed_price ?? undefined,
      target_segment: product.target_segment ?? "",
      promotion_eligible: product.promotion_eligible,
      is_perishable: product.is_perishable,
      is_child_product: product.is_child_product,
      weight_kg: product.weight_kg ?? undefined,
      tags: product.tags.join(", "),
      status: product.status,
    },
  });
  const m = useMutation({
    mutationFn: (v: z.output<typeof editProductSchema>) =>
      api.patch<AdminProduct>(`/merchant/products/${product.id}`, {
        name: v.name,
        description: v.description ?? "",
        ...(v.category_id ? { category_id: v.category_id } : {}),
        brand: blankToNull(v.brand),
        unit: v.unit,
        cost_price: v.cost_price,
        min_allowed_price: v.min_allowed_price ?? null,
        target_segment: blankToNull(v.target_segment),
        promotion_eligible: v.promotion_eligible,
        is_perishable: v.is_perishable,
        is_child_product: v.is_child_product,
        weight_kg: v.weight_kg ?? null,
        tags: parseTags(v.tags),
        status: v.status,
      }),
    onSuccess: (p) => {
      toast.success(`Saved ${p.sku}`);
      invalidate();
      onDone();
    },
  });
  const minPrice = form.watch("min_allowed_price") as number | undefined;
  const e = form.formState.errors;
  return (
    <form
      onSubmit={form.handleSubmit((v) => {
        if (v.min_allowed_price !== undefined && v.min_allowed_price > product.price) {
          form.setError("min_allowed_price", { message: `Cannot exceed the current price (${formatCurrency(product.price)})` });
          return;
        }
        m.mutate(v);
      })}
      noValidate
      className="space-y-4"
    >
      <Callout title={`Selling price: ${formatCurrency(product.price)}`}>
        The selling price is not editable here. Price changes go through the approval workflow so guardrails (floors, maximum markdown, no automated increases) are enforced and audited.{" "}
        <Link to="/merchant/pricing" className="font-medium text-primary underline-offset-2 hover:underline">
          Propose a price change in Pricing
        </Link>
        .
      </Callout>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="pf-name" error={e.name?.message}>
          <Input id="pf-name" {...form.register("name")} aria-invalid={!!e.name} />
        </Field>
        <Field label="Status" htmlFor="pf-status">
          <Select id="pf-status" {...form.register("status")}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
        </Field>
        <SharedFields form={form as never} categories={categories} />
      </div>
      {minPrice !== undefined && !Number.isNaN(minPrice) && minPrice > product.price && (
        <p className="text-xs text-danger">Minimum price is above the current selling price.</p>
      )}
      <GuardrailError error={m.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={m.isPending}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}

type SharedForm = ReturnType<typeof useForm<CreateValues>>;

function SharedFields({ form, categories }: { form: SharedForm; categories: MerchantCategory[] }) {
  const e = form.formState.errors;
  return (
    <>
      <Field label="Unit cost (₹)" htmlFor="pf-cost" error={e.cost_price?.message}>
        <Input id="pf-cost" type="number" step="0.01" min="0" {...form.register("cost_price", { valueAsNumber: true })} aria-invalid={!!e.cost_price} />
      </Field>
      <Field label="Minimum allowed price (₹)" htmlFor="pf-min" error={e.min_allowed_price?.message} hint="Optional price floor for markdowns and promotions">
        <Input id="pf-min" type="number" step="0.01" min="0" {...form.register("min_allowed_price", { valueAsNumber: true })} aria-invalid={!!e.min_allowed_price} />
      </Field>
      <Field label="Category" htmlFor="pf-cat">
        <Select id="pf-cat" {...form.register("category_id")}>
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Brand" htmlFor="pf-brand" error={e.brand?.message}>
        <Input id="pf-brand" {...form.register("brand")} />
      </Field>
      <Field label="Unit" htmlFor="pf-unit" error={e.unit?.message} hint="e.g. each, 500 g, 1 L">
        <Input id="pf-unit" {...form.register("unit")} aria-invalid={!!e.unit} />
      </Field>
      <Field label="Weight (kg)" htmlFor="pf-weight" error={e.weight_kg?.message}>
        <Input id="pf-weight" type="number" step="0.001" min="0" {...form.register("weight_kg", { valueAsNumber: true })} aria-invalid={!!e.weight_kg} />
      </Field>
      <Field label="Target segment" htmlFor="pf-seg">
        <Input id="pf-seg" {...form.register("target_segment")} placeholder="e.g. families, all" />
      </Field>
      <Field label="Tags" htmlFor="pf-tags" hint="Comma separated, e.g. rain, breakfast">
        <Input id="pf-tags" {...form.register("tags")} />
      </Field>
      <Field label="Description" htmlFor="pf-desc" className="sm:col-span-2">
        <Textarea id="pf-desc" {...form.register("description")} rows={2} />
      </Field>
      <fieldset className="flex flex-wrap gap-x-6 gap-y-2 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">Flags</legend>
        <Checkbox label="Promotion eligible" {...form.register("promotion_eligible")} />
        <Checkbox label="Perishable" {...form.register("is_perishable")} />
        <Checkbox label="Child product (restricted targeting)" {...form.register("is_child_product")} />
      </fieldset>
    </>
  );
}

const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { label: string }>(({ label, ...props }, ref) => (
  <label className="inline-flex items-center gap-2 text-sm">
    <input ref={ref} type="checkbox" className="size-4 rounded border-border-strong accent-primary" {...props} />
    {label}
  </label>
));
Checkbox.displayName = "Checkbox";
