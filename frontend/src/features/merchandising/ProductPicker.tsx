/** Searchable product list (GET /merchant/products). Items can be dragged (dataTransfer "text/plain" = product id) or selected. */
import { useQuery } from "@tanstack/react-query";
import { GripVertical, Search } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { SkeletonRows } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { Page } from "@/types/api";
import { cn, formatCurrency } from "@/lib/utils";

import type { MerchantProduct } from "./types";

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useProductSearch(q: string) {
  const dq = useDebounced(q.trim());
  return useQuery({
    queryKey: ["merchant", "product-search", dq],
    queryFn: () => api.get<Page<MerchantProduct>>("/merchant/products", { q: dq || undefined, page_size: 20, status: "active" }),
    staleTime: 60_000,
  });
}

interface Props {
  selectedId?: string | null;
  onSelect: (p: MerchantProduct) => void;
  draggable?: boolean;
  label?: string;
  className?: string;
  listClassName?: string;
}

export function ProductPicker({ selectedId, onSelect, draggable, label = "Search products", className, listClassName }: Props) {
  const [q, setQ] = React.useState("");
  const res = useProductSearch(q);
  const id = React.useId();
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, SKU or brand" className="pl-8" />
      </div>
      {res.isLoading ? (
        <SkeletonRows rows={4} />
      ) : res.isError ? (
        <p className="text-sm text-danger">Product search failed.</p>
      ) : !res.data?.items.length ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No products match “{q}”.</p>
      ) : (
        <ul className={cn("flex max-h-80 flex-col gap-1 overflow-y-auto pr-1", listClassName)} aria-label="Products">
          {res.data.items.map((p) => {
            const sel = p.id === selectedId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  draggable={draggable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", p.id);
                    e.dataTransfer.effectAllowed = "copyMove";
                    onSelect(p);
                  }}
                  onClick={() => onSelect(p)}
                  aria-pressed={sel}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors",
                    sel ? "border-primary bg-primary-soft" : "border-transparent hover:bg-muted",
                    draggable && "cursor-grab active:cursor-grabbing",
                  )}
                >
                  {draggable && <GripVertical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{p.sku}</span>
                      {p.category_name && <span>· {p.category_name}</span>}
                      <span>· {formatCurrency(p.price)}</span>
                      {p.weight_kg != null && p.weight_kg >= 5 && <Badge variant="warning">{p.weight_kg} kg</Badge>}
                      {p.is_child_product && <Badge variant="info">Child</Badge>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {res.data && res.data.total > res.data.items.length && (
        <p className="text-xs text-muted-foreground">
          Showing {res.data.items.length} of {res.data.total}. Refine the search to narrow results.
        </p>
      )}
    </div>
  );
}
