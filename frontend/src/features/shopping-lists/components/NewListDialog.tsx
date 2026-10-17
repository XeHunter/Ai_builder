/**
 * "New smart list" flow: free text → POST /shopping-lists/parse → review every match → name → create.
 * Unresolved items stay unresolved (the shopper can pick a candidate, but nothing is invented).
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Sparkles, Trash2 } from "lucide-react";
import * as React from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Provenance } from "@/components/ui/data";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/feedback";
import { Field, Input, Label, Select, Textarea } from "@/components/ui/input";
import { useShopperStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type { ParsedItem, ParseResponse, ShoppingListView } from "@/types/api";
import { MY_LISTS_KEY } from "@/features/shopping-assistant/components/AddToListButton";

const EXAMPLE = "Milk, eggs, bread, chocolate, diapers, detergent, and coffee.";

const itemSchema = z.object({
  key: z.string(),
  raw_text: z.string().trim().min(1),
  product_id: z.string(),
  quantity: z.number({ error: "Enter a quantity" }).gt(0, "Must be more than 0").max(1000, "At most 1000"),
  unit: z.string().trim().max(16, "Too long"),
});

export const newListSchema = z.object({
  name: z.string().trim().min(1, "Give your list a name").max(120, "Keep the name under 120 characters"),
  items: z.array(itemSchema).min(1, "Keep at least one item on the list"),
});
type FormValues = z.infer<typeof newListSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewListDialog({ open, onOpenChange }: Props) {
  const { store, storeId } = useShopperStore();
  const [text, setText] = React.useState("");
  const [parsed, setParsed] = React.useState<ParseResponse | null>(null);

  const parse = useMutation({
    mutationFn: (t: string) => api.post<ParseResponse>("/shopping-lists/parse", { store_id: storeId, text: t }),
    onSuccess: setParsed,
  });

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setParsed(null);
      parse.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={parsed ? "Review your list" : "New smart list"}
        description={parsed ? "Check each match before saving. Change products, quantities, or remove items." : `Type or paste your list. We'll match items to ${store?.name ?? "the store"}'s catalog.`}
        size="xl"
      >
        {!parsed ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) parse.mutate(text.trim());
            }}
          >
            <Field label="What do you need?" htmlFor="list-text" hint="Separate items with commas or new lines. Quantities like “2 kg rice” are understood.">
              <Textarea id="list-text" rows={5} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} autoFocus />
            </Field>
            {parse.isError && (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(parse.error)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setText(EXAMPLE)}>
                Use example
              </Button>
              <Button type="submit" loading={parse.isPending} disabled={!text.trim() || !storeId}>
                <Sparkles aria-hidden /> Match products
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <ReviewForm parsed={parsed} rawText={text} storeId={storeId} onBack={() => setParsed(null)} onDone={() => close(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function toFormItem(it: ParsedItem, i: number): FormValues["items"][number] {
  return { key: `${i}`, raw_text: it.raw_text, product_id: it.product_id ?? "", quantity: it.quantity, unit: it.unit ?? "" };
}

function ReviewForm({ parsed, rawText, storeId, onBack, onDone }: { parsed: ParseResponse; rawText: string; storeId: string | null; onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const meta = React.useMemo(() => new Map(parsed.items.map((it, i) => [`${i}`, it])), [parsed]);
  const form = useForm<FormValues>({
    resolver: zodResolver(newListSchema),
    defaultValues: { name: `Shopping ${formatDate(new Date())}`, items: parsed.items.map(toFormItem) },
  });
  const { fields, remove } = useFieldArray({ control: form.control, name: "items", keyName: "fieldId" });
  const values = form.watch("items");

  const create = useMutation({
    mutationFn: (v: FormValues) =>
      api.post<ShoppingListView>("/shopping-lists", {
        name: v.name,
        store_id: storeId,
        raw_input: rawText,
        items: v.items.map((it) => ({ raw_text: it.raw_text, product_id: it.product_id || null, skip_match: !it.product_id, quantity: it.quantity, unit: it.unit || null })),
      }),
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: MY_LISTS_KEY });
      toast.success(`Created “${list.name}”`);
      onDone();
      navigate(`/shop/lists/${list.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const errors = form.formState.errors;
  const unresolvedCount = values.filter((v) => !v.product_id).length;

  return (
    <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          {fields.length} item{fields.length === 1 ? "" : "s"}
        </span>
        {unresolvedCount > 0 && <Badge variant="danger">{unresolvedCount} without a match</Badge>}
        <Provenance kind={parsed.parser.kind === "deterministic" ? "deterministic" : "llm"} detail={`Parser: ${parsed.parser.provider}${parsed.parser.fell_back ? " (fallback)" : ""}`} />
      </div>

      {parsed.duplicates_merged.length > 0 && (
        <Callout title="Duplicates merged">
          {parsed.duplicates_merged.map((d) => `“${d.raw_text}” was merged into ${d.merged_into}`).join("; ")}.
        </Callout>
      )}
      {parsed.unresolved.length > 0 && (
        <Callout tone="warning" title="Some items have no match in this store">
          {parsed.unresolved.join(", ")} will be saved as typed and marked unresolved — you can match them later.
        </Callout>
      )}

      <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Parsed items">
        {fields.map((f, idx) => {
          const m = meta.get(f.key);
          const current = values[idx];
          const unresolved = !current?.product_id;
          const candidates = m?.candidates ?? [];
          const hasCurrent = !current?.product_id || candidates.some((c) => c.product_id === current.product_id);
          const itemErrors = errors.items?.[idx];
          return (
            <li key={f.fieldId} className={cn("grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto]", unresolved && "bg-danger-soft/40")} data-testid="review-item">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">“{f.raw_text}”</span>
                  {unresolved ? (
                    <Badge variant="danger">
                      <AlertTriangle className="size-3" aria-hidden /> Unresolved
                    </Badge>
                  ) : (
                    m && (
                      <Badge variant={m.confidence >= 0.8 ? "success" : m.confidence >= 0.5 ? "warning" : "danger"}>{Math.round(m.confidence * 100)}% confidence</Badge>
                    )
                  )}
                  {!unresolved && m?.needs_review && <Badge variant="warning">Please check</Badge>}
                  {m?.status === "unavailable" && <Badge variant="warning">Out of stock</Badge>}
                </div>
                <div>
                  <Label htmlFor={`item-${f.fieldId}-product`} className="sr-only">
                    Product for {f.raw_text}
                  </Label>
                  <Select id={`item-${f.fieldId}-product`} {...form.register(`items.${idx}.product_id`)}>
                    {!hasCurrent && m && <option value={current.product_id}>{m.display_name}</option>}
                    {candidates.map((c) => (
                      <option key={c.product_id} value={c.product_id}>
                        {c.name} — {formatCurrency(c.price)}
                        {c.location ? ` · ${c.location}` : ""}
                        {c.in_stock ? "" : " · out of stock"}
                      </option>
                    ))}
                    <option value="">{candidates.length ? "No match — keep as typed" : "No matching product in this store"}</option>
                  </Select>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-20">
                  <Label htmlFor={`item-${f.fieldId}-qty`} className="text-xs text-muted-foreground">
                    Qty
                  </Label>
                  <Input
                    id={`item-${f.fieldId}-qty`}
                    type="number"
                    step="any"
                    min={0}
                    aria-invalid={!!itemErrors?.quantity}
                    {...form.register(`items.${idx}.quantity`, { valueAsNumber: true })}
                  />
                </div>
                <div className="w-20">
                  <Label htmlFor={`item-${f.fieldId}-unit`} className="text-xs text-muted-foreground">
                    Unit
                  </Label>
                  <Input id={`item-${f.fieldId}-unit`} placeholder="—" {...form.register(`items.${idx}.unit`)} />
                </div>
                <Button type="button" variant="ghost" size="icon" className="mt-5" aria-label={`Remove ${f.raw_text}`} onClick={() => remove(idx)}>
                  <Trash2 />
                </Button>
              </div>
              {(itemErrors?.quantity || itemErrors?.unit) && (
                <p role="alert" className="text-xs text-danger sm:col-span-2">
                  {itemErrors.quantity?.message ?? itemErrors.unit?.message}
                </p>
              )}
            </li>
          );
        })}
        {fields.length === 0 && <li className="p-4 text-center text-sm text-muted-foreground">All items removed.</li>}
      </ul>
      {errors.items?.root?.message || errors.items?.message ? (
        <p role="alert" className="text-sm text-danger">
          {errors.items?.root?.message ?? errors.items?.message}
        </p>
      ) : null}

      <Field label="List name" htmlFor="list-name" error={errors.name?.message}>
        <Input id="list-name" maxLength={120} aria-invalid={!!errors.name} {...form.register("name")} />
      </Field>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden /> Edit text
        </Button>
        <Button type="submit" loading={create.isPending}>
          Create list
        </Button>
      </DialogFooter>
    </form>
  );
}
