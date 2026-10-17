/** Pick the catalog product for a list item: the parser's candidates first, plus a live catalog search. */
import { Search } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { cn, formatCurrency } from "@/lib/utils";
import type { ListItem } from "@/types/api";
import { useDebouncedValue, useStoreProducts } from "@/features/shopping-assistant/hooks";
import { effectivePrice } from "@/features/shopping-assistant/components/product-meta";

interface Option {
  product_id: string;
  name: string;
  price: number;
  in_stock: boolean;
  location: string | null;
  score?: number | null;
}

interface Props {
  item: ListItem | null;
  storeId: string | null;
  saving: boolean;
  onClose: () => void;
  onSelect: (productId: string) => void;
}

export function ChangeMatchDialog({ item, storeId, saving, onClose, onSelect }: Props) {
  const [q, setQ] = React.useState("");
  const [choice, setChoice] = React.useState<string | null>(null);
  const debounced = useDebouncedValue(q, 300);
  React.useEffect(() => {
    setQ(item?.raw_text ?? "");
    setChoice(item?.product_id ?? null);
  }, [item]);
  const search = useStoreProducts(storeId, { q: debounced, page_size: 8 }, !!item && debounced.trim().length > 1);

  const options: Option[] = React.useMemo(() => {
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const c of item?.candidates ?? []) {
      if (seen.has(c.product_id)) continue;
      seen.add(c.product_id);
      out.push(c);
    }
    for (const p of search.data?.items ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ product_id: p.id, name: p.name, price: effectivePrice(p), in_stock: p.in_stock, location: p.location?.shelf_code ?? null });
    }
    return out;
  }, [item, search.data]);

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Choose a product" description={item ? `For “${item.raw_text}”` : undefined} size="md">
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this store" aria-label="Search products" className="pl-9" />
          </div>
          {search.isFetching && <Spinner label="Searching" />}
          {options.length === 0 && !search.isFetching ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No matching products in this store.</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto" role="radiogroup" aria-label="Products">
              {options.map((o) => (
                <li key={o.product_id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={choice === o.product_id}
                    onClick={() => setChoice(o.product_id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm",
                      choice === o.product_id ? "border-primary bg-primary-soft" : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{o.name}</span>
                      <span className="text-xs text-muted-foreground">{o.location ? `Shelf ${o.location}` : "Location not mapped"}</span>
                    </span>
                    {!o.in_stock && <Badge variant="warning">Out of stock</Badge>}
                    <span className="tabular">{formatCurrency(o.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!choice || choice === item?.product_id} loading={saving} onClick={() => choice && onSelect(choice)}>
            Use this product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
