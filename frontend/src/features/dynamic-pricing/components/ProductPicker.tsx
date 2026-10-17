import { useQuery } from "@tanstack/react-query";
import { Plus, Search, X } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/feedback";
import type { AdminProduct } from "@/features/inventory/types";
import { useDebouncedValue } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";
import type { Page } from "@/types/api";

export interface PickedProduct {
  id: string;
  name: string;
  sku?: string;
  price?: number;
}

interface Props {
  id: string;
  value: PickedProduct[];
  onChange: (v: PickedProduct[]) => void;
  multiple?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/** Searchable product selector backed by GET /merchant/products?q=. */
export function ProductPicker({ id, value, onChange, multiple = true, invalid, describedBy }: Props) {
  const [text, setText] = React.useState("");
  const q = useDebouncedValue(text.trim(), 250);
  const res = useQuery({
    queryKey: ["merchant", "catalog", "products", "picker", q],
    queryFn: () => api.get<Page<AdminProduct>>("/merchant/products", { q, status: "active", page_size: 8 }),
    enabled: q.length >= 2,
  });
  const selected = new Set(value.map((v) => v.id));
  const add = (p: AdminProduct) => {
    const picked = { id: p.id, name: p.name, sku: p.sku, price: p.price };
    onChange(multiple ? (selected.has(p.id) ? value : [...value, picked]) : [picked]);
    if (!multiple) setText("");
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected products">
          {value.map((p) => (
            <li key={p.id}>
              <Badge variant="primary" className="gap-1 py-1 pl-2.5 pr-1">
                {p.name}
                {p.price !== undefined && <span className="tabular opacity-70">{formatCurrency(p.price)}</span>}
                <button type="button" aria-label={`Remove ${p.name}`} className="rounded-full p-0.5 hover:bg-primary/10" onClick={() => onChange(value.filter((v) => v.id !== p.id))}>
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input
          id={id}
          className="pl-8"
          placeholder="Search products by name or SKU (2+ characters)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          autoComplete="off"
        />
      </div>
      {q.length >= 2 && (
        <div className="max-h-48 overflow-auto rounded-md border border-border">
          {res.isLoading ? (
            <Spinner className="p-3" label="Searching" />
          ) : res.isError ? (
            <p className="p-3 text-sm text-danger">{errorMessage(res.error)}</p>
          ) : !res.data?.items.length ? (
            <p className="p-3 text-sm text-muted-foreground">No products match “{q}”.</p>
          ) : (
            <ul role="listbox" aria-label="Product search results" aria-multiselectable={multiple}>
              {res.data.items.map((p) => {
                const isSel = selected.has(p.id);
                return (
                  <li key={p.id} role="option" aria-selected={isSel}>
                    <button
                      type="button"
                      onClick={() => add(p)}
                      disabled={isSel && multiple}
                      className={cn("flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50", isSel && "bg-primary-soft")}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{p.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {p.sku}
                          {!p.promotion_eligible && " · not promotion-eligible"}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="tabular text-xs">{formatCurrency(p.price)}</span>
                        <Plus className="size-4 text-muted-foreground" aria-hidden />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
