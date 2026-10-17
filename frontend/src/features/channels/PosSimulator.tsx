/** Browser POS simulator: rings up a bill through exactly the same path as a real connector. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Minus, Plus, Receipt, Search, ShoppingBasket, Shuffle, Trash2 } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout, Spinner } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import type { InventoryRow } from "@/features/inventory/types";
import { GuardrailError, useDebouncedValue } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, ApiError } from "@/lib/api";
import { cn, formatCurrency, formatDateTime, formatNumber, titleCase } from "@/lib/utils";
import type { Page } from "@/types/api";

import { CHANNEL_META, CHANNELS_KEY, ORDERS_KEY } from "./channel-meta";
import type { PaymentMethod, SalesChannel, Shortfall, SimulatedOrder } from "./types";

interface BasketLine {
  product_id: string;
  sku: string;
  name: string;
  price: number;
  on_hand: number;
  quantity: number;
}

const CHANNELS: { value: SalesChannel; label: string }[] = [
  { value: "pos", label: "POS counter" },
  { value: "self_checkout", label: "Self-checkout" },
  { value: "online", label: "Online order" },
];
const PAYMENTS: PaymentMethod[] = ["upi", "card", "cash", "wallet"];
const MAX_QTY = 50;

export function PosSimulator({ className }: { className?: string }) {
  const { can } = useAuth();
  const { stores, concreteStoreId } = useMerchantStore();
  const qc = useQueryClient();
  const allowed = can("inventory.write");

  const [storeId, setStoreId] = React.useState<string | null>(null);
  const activeStore = storeId ?? concreteStoreId;
  const [channel, setChannel] = React.useState<SalesChannel>("pos");
  const [payment, setPayment] = React.useState<PaymentMethod>("upi");
  const [basket, setBasket] = React.useState<BasketLine[]>([]);
  const [search, setSearch] = React.useState("");
  const q = useDebouncedValue(search.trim(), 250);
  const [receipt, setReceipt] = React.useState<SimulatedOrder | null>(null);

  const results = useQuery({
    queryKey: ["merchant", "inventory", "list", activeStore, q, "simulator"],
    queryFn: () => api.get<Page<InventoryRow>>("/merchant/inventory", { store_id: activeStore, q, page: 1, page_size: 10 }),
    enabled: Boolean(activeStore && q.length >= 2),
  });

  const sim = useMutation({
    mutationFn: (lines: BasketLine[]) =>
      api.post<SimulatedOrder>("/merchant/channels/simulate", {
        store_id: activeStore,
        channel,
        payment_method: payment,
        lines: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })),
      }),
    onSuccess: (order) => {
      setReceipt(order);
      setBasket([]);
      void qc.invalidateQueries({ queryKey: ORDERS_KEY });
      void qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      void qc.invalidateQueries({ queryKey: ["merchant", "inventory"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "overview"] });
    },
  });

  const add = (row: InventoryRow) => {
    setBasket((prev) => {
      const hit = prev.find((l) => l.product_id === row.product_id);
      if (hit) return prev.map((l) => (l === hit ? { ...l, quantity: Math.min(MAX_QTY, l.quantity + 1) } : l));
      return [...prev, { product_id: row.product_id, sku: row.sku, name: row.name, price: row.price, on_hand: row.quantity_on_hand, quantity: 1 }];
    });
  };
  const setQty = (id: string, qty: number) =>
    setBasket((prev) => prev.map((l) => (l.product_id === id ? { ...l, quantity: Math.max(1, Math.min(MAX_QTY, Math.round(qty) || 1)) } : l)));
  const remove = (id: string) => setBasket((prev) => prev.filter((l) => l.product_id !== id));
  const basketTotal = basket.reduce((s, l) => s + l.price * l.quantity, 0);

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="size-4 text-primary" aria-hidden /> POS simulator
          </CardTitle>
          <CardDescription>Ring up a bill to watch stock, low-stock alerts and the live feed react, exactly as a real till would.</CardDescription>
        </div>
        <Badge variant="accent">Simulated</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {!allowed && <Callout tone="info">You need the inventory write permission to ring up simulated orders.</Callout>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Store" htmlFor="sim-store">
            <Select
              id="sim-store"
              value={activeStore ?? ""}
              onChange={(e) => {
                setStoreId(e.target.value);
                setBasket([]);
              }}
              disabled={!stores.length}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Channel" htmlFor="sim-channel">
            <Select id="sim-channel" value={channel} onChange={(e) => setChannel(e.target.value as SalesChannel)}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Payment" htmlFor="sim-payment">
            <Select id="sim-payment" value={payment} onChange={(e) => setPayment(e.target.value as PaymentMethod)}>
              {PAYMENTS.map((p) => (
                <option key={p} value={p}>
                  {p === "upi" ? "UPI" : titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => sim.mutate([])} loading={sim.isPending && sim.variables?.length === 0} disabled={!allowed || !activeStore || sim.isPending}>
            <Shuffle aria-hidden /> Ring up random basket
          </Button>
          <span className="text-xs text-muted-foreground">or build a basket below</span>
        </div>

        <div className="rounded-lg border border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              aria-label="Search products to add"
              placeholder="Search products by name or SKU…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              disabled={!allowed || !activeStore}
            />
          </div>
          {q.length >= 2 && (
            <div className="mt-2">
              {results.isLoading ? (
                <Spinner label="Searching" className="py-2" />
              ) : results.isError ? (
                <p className="py-2 text-sm text-danger">Search failed. Try again.</p>
              ) : (results.data?.items ?? []).length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">No products match “{q}”.</p>
              ) : (
                <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="Product search results">
                  {results.data!.items.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.sku} · {formatCurrency(r.price)} · {formatNumber(r.quantity_on_hand)} on hand
                        </p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => add(r)} disabled={r.quantity_on_hand <= 0 && channel === "online"} aria-label={`Add ${r.name}`}>
                        <Plus aria-hidden /> Add
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {basket.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ShoppingBasket className="size-3.5" aria-hidden /> Basket
              </p>
              <ul className="space-y-1.5" aria-label="Basket">
                {basket.map((l) => (
                  <li key={l.product_id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {l.name} <span className="text-xs text-muted-foreground">({l.sku})</span>
                    </span>
                    <div className="flex items-center gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Decrease ${l.name}`} onClick={() => setQty(l.product_id, l.quantity - 1)} disabled={l.quantity <= 1}>
                        <Minus aria-hidden />
                      </Button>
                      <Input
                        type="number"
                        min={1}
                        max={MAX_QTY}
                        value={l.quantity}
                        onChange={(e) => setQty(l.product_id, Number(e.target.value))}
                        className="h-7 w-14 px-1.5 text-center"
                        aria-label={`Quantity of ${l.name}`}
                      />
                      <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Increase ${l.name}`} onClick={() => setQty(l.product_id, l.quantity + 1)} disabled={l.quantity >= MAX_QTY}>
                        <Plus aria-hidden />
                      </Button>
                    </div>
                    <span className="tabular w-20 text-right">{formatCurrency(l.price * l.quantity)}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" aria-label={`Remove ${l.name}`} onClick={() => remove(l.product_id)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                <span className="text-sm text-muted-foreground">
                  Shelf-price estimate <span className="tabular font-semibold text-foreground">{formatCurrency(basketTotal)}</span>
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setBasket([])}>
                    Clear
                  </Button>
                  <Button size="sm" onClick={() => sim.mutate(basket)} loading={sim.isPending && (sim.variables?.length ?? 0) > 0} disabled={!allowed || sim.isPending}>
                    <Receipt aria-hidden /> Ring up basket ({basket.length})
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Search above and add products to ring up a specific bill.</p>
          )}
        </div>

        {sim.error ? <SimulationError error={sim.error} /> : null}
        {receipt && <ReceiptView order={receipt} />}
      </CardContent>
    </Card>
  );
}

function SimulationError({ error }: { error: unknown }) {
  const shortfalls = error instanceof ApiError ? ((error.details as { shortfalls?: Shortfall[] } | null)?.shortfalls ?? []) : [];
  if (!shortfalls.length) return <GuardrailError error={error} />;
  return (
    <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-danger">
        <AlertTriangle className="size-4" aria-hidden /> {(error as ApiError).message}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-6 text-foreground/85">
        {shortfalls.map((s) => (
          <li key={s.sku}>
            {s.name} ({s.sku}): requested {s.requested}, only {s.available} available
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReceiptView({ order: o }: { order: SimulatedOrder }) {
  const meta = CHANNEL_META[o.channel];
  return (
    <section aria-label="Receipt" className="rounded-lg border border-border bg-surface-raised">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Receipt className="size-4 text-primary" aria-hidden />
          <span className="font-semibold">{o.receipt_number}</span>
          {meta && <Badge variant={meta.variant}>{meta.label}</Badge>}
          {o.store_code && <Badge variant="outline">{o.store_code}</Badge>}
          {o.duplicate && <Badge variant="warning">Duplicate (already recorded)</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(o.occurred_at)} · {o.payment_method === "upi" ? "UPI" : titleCase(o.payment_method)}
        </span>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>Item</TH>
            <TH className="text-right">Qty</TH>
            <TH className="text-right">Price</TH>
            <TH className="text-right">Total</TH>
          </TR>
        </THead>
        <TBody>
          {o.lines.map((l, i) => (
            <TR key={`${l.sku}-${i}`}>
              <TD>
                <span className="font-medium">{l.name}</span>
                {l.sku && <span className="ml-1 text-xs text-muted-foreground">{l.sku}</span>}
              </TD>
              <TD className="tabular text-right">{l.quantity}</TD>
              <TD className="tabular text-right">{formatCurrency(l.unit_price)}</TD>
              <TD className="tabular text-right">{formatCurrency(l.line_total)}</TD>
            </TR>
          ))}
          <TR className="hover:bg-transparent">
            <TD colSpan={3} className="text-right font-medium">
              Total ({o.item_count} item{o.item_count === 1 ? "" : "s"})
            </TD>
            <TD className="tabular text-right text-base font-semibold">{formatCurrency(o.total)}</TD>
          </TR>
        </TBody>
      </Table>
      {(o.low_stock.length > 0 || o.shortfalls.length > 0) && (
        <div className="space-y-2 border-t border-border p-3">
          {o.low_stock.length > 0 && (
            <Callout tone="warning" title="This sale pushed items to low stock">
              <ul className="mt-1 space-y-0.5">
                {o.low_stock.map((s) => (
                  <li key={s.sku}>
                    {s.name} ({s.sku}): {s.on_hand} left, reorder point {s.reorder_point}, suggested reorder {s.reorder_quantity}
                  </li>
                ))}
              </ul>
              <Link to="/merchant/inventory" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
                Open inventory
              </Link>
            </Callout>
          )}
          {o.shortfalls.length > 0 && (
            <Callout tone="warning" title="Sold more than recorded stock">
              <ul className="mt-1 space-y-0.5">
                {o.shortfalls.map((s) => (
                  <li key={s.sku}>
                    {s.name} ({s.sku}): sold {s.requested}, system had {s.available}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      )}
    </section>
  );
}
