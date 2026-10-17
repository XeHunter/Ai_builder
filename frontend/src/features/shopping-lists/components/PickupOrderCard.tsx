import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, PackageCheck } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { effectivePrice } from "@/features/shopping-assistant/components/product-meta";
import { api, errorMessage } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import type { ListItem } from "@/types/api";

import { listKey } from "../use-live-list";

interface PickupOrder {
  id: string;
  receipt_number: string;
  total: number;
  item_count: number;
  store_name: string | null;
  lines: { sku: string | null; name: string; quantity: number; line_total: number }[];
}

/**
 * Click & collect: order the matched, uncollected items for pickup. The order goes through the same
 * omnichannel ingestion as a POS bill, so the store's stock and live feed update immediately.
 */
export function PickupOrderCard({ listId, storeName, items }: { listId: string; storeName: string | null; items: ListItem[] }) {
  const qc = useQueryClient();
  const [payment, setPayment] = React.useState("upi");
  const [placed, setPlaced] = React.useState<PickupOrder | null>(null);
  const orderable = items.filter((i) => i.status === "pending" && i.product_id && i.product?.in_stock !== false);
  const estimate = orderable.reduce((s, i) => s + (i.product ? effectivePrice(i.product) * Math.max(1, Math.ceil(i.quantity)) : 0), 0);

  const order = useMutation({
    mutationFn: () => api.post<PickupOrder>(`/shopping-lists/${listId}/order`, { payment_method: payment }),
    onSuccess: (o) => {
      setPlaced(o);
      toast.success(`Order ${o.receipt_number} placed`);
      void qc.invalidateQueries({ queryKey: listKey(listId) });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (placed) {
    return (
      <Card className="space-y-3 p-4" role="status">
        <div className="flex items-center gap-2 font-semibold text-success">
          <CheckCircle2 className="size-5" aria-hidden /> Ready for pickup soon
        </div>
        <p className="text-sm text-muted-foreground">
          Order <span className="font-mono text-foreground">{placed.receipt_number}</span> · {placed.item_count} items ·{" "}
          <span className="tabular font-semibold text-foreground">{formatCurrency(placed.total)}</span>
          {placed.store_name ? ` · collect at ${placed.store_name}` : ""}
        </p>
        <ul className="space-y-1 text-sm">
          {placed.lines.map((l) => (
            <li key={`${l.sku}-${l.name}`} className="flex justify-between gap-2">
              <span className="truncate">
                {l.quantity} × {l.name}
              </span>
              <span className="tabular text-muted-foreground">{formatCurrency(l.line_total)}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">The store's stock and live order feed updated the moment you ordered.</p>
      </Card>
    );
  }

  if (!orderable.length) return null;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <PackageCheck className="size-5 text-primary" aria-hidden /> Order for pickup
        </h2>
        <Badge variant="info">Click &amp; collect</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Skip the aisles: we pick {orderable.length} item{orderable.length === 1 ? "" : "s"} for you
        {storeName ? ` at ${storeName}` : ""}. Est. <span className="tabular font-medium text-foreground">{formatCurrency(estimate)}</span>
      </p>
      <div className="flex gap-2">
        <Select value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Payment method" className="w-40">
          <option value="upi">UPI</option>
          <option value="card">Card</option>
          <option value="cash">Pay at pickup</option>
        </Select>
        <Button className="flex-1" loading={order.isPending} onClick={() => order.mutate()}>
          Place order
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Payment is simulated in this demo.</p>
    </Card>
  );
}
