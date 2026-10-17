/** Simulated POS / self-checkout / online transaction ingestion: records a transaction and scores it immediately. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { KeyValue } from "@/components/ui/data";
import { ProductPicker } from "@/features/merchandising/ProductPicker";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

import type { IngestResult } from "./types";

interface Line {
  product_id: string;
  name: string;
  price: number;
  quantity: number;
  detected_quantity: number | null;
}

export function SimulateTab({ onOpenAlert }: { onOpenAlert: (id: string) => void }) {
  const { stores, concreteStoreId } = useMerchantStore();
  const qc = useQueryClient();
  const [store, setStore] = React.useState(concreteStoreId ?? "");
  const [channel, setChannel] = React.useState<"pos" | "self_checkout" | "online">("self_checkout");
  const [type, setType] = React.useState<"sale" | "return">("sale");
  const [receipt, setReceipt] = React.useState("");
  const [terminal, setTerminal] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<IngestResult | null>(null);
  React.useEffect(() => {
    if (!store && concreteStoreId) setStore(concreteStoreId);
  }, [concreteStoreId, store]);

  const submit = useMutation({
    mutationFn: () =>
      api.post<IngestResult>("/merchant/fraud/transactions", {
        store_id: store,
        channel,
        transaction_type: type,
        original_receipt_number: type === "return" && receipt.trim() ? receipt.trim() : null,
        terminal_id: terminal.trim() || null,
        items: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, detected_quantity: channel === "self_checkout" ? l.detected_quantity : null })),
      }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(r.alert ? `Recorded ${r.receipt_number}: alert raised for review` : `Recorded ${r.receipt_number}: no alert`);
      void qc.invalidateQueries({ queryKey: ["merchant", "fraud-alerts"] });
      void qc.invalidateQueries({ queryKey: ["merchant", "fraud-eval"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!store) return setError("Choose a store.");
    if (!lines.length) return setError("Add at least one item.");
    if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1)) return setError("Quantities must be whole numbers of at least 1.");
    if (lines.some((l) => l.detected_quantity != null && (l.detected_quantity < 0 || !Number.isInteger(l.detected_quantity)))) return setError("Detected quantities must be whole numbers ≥ 0.");
    setError(null);
    submit.mutate();
  };

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((n, l) => n + l.price * l.quantity, 0);

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="simulated" title="Simulated hardware">
        POS terminals, self-checkout bagging scales and the e-commerce feed are simulated. Submitted transactions are flagged
        as simulated, do not change inventory, and are scored immediately with the live rules and anomaly model.
      </Callout>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader>
            <CardTitle>Transaction</CardTitle>
            <CardDescription>Try a self-checkout with a detected quantity above the charged quantity, or a return of items not on the original receipt.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Store" htmlFor="sim-store">
                  <Select id="sim-store" value={store} onChange={(e) => setStore(e.target.value)}>
                    {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                <Field label="Channel" htmlFor="sim-channel">
                  <Select id="sim-channel" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                    <option value="pos">POS</option>
                    <option value="self_checkout">Self-checkout</option>
                    <option value="online">Online</option>
                  </Select>
                </Field>
                <Field label="Type" htmlFor="sim-type">
                  <Select id="sim-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                    <option value="sale">Sale</option>
                    <option value="return">Return</option>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {type === "return" && (
                  <Field label="Original receipt number (optional)" htmlFor="sim-receipt" hint="Links the return to a sale for receipt checks">
                    <Input id="sim-receipt" value={receipt} maxLength={40} onChange={(e) => setReceipt(e.target.value)} placeholder="e.g. AND01-261010-1A2B3C" />
                  </Field>
                )}
                <Field label="Terminal ID (optional)" htmlFor="sim-terminal">
                  <Input id="sim-terminal" value={terminal} maxLength={32} onChange={(e) => setTerminal(e.target.value)} placeholder="SCO-2" />
                </Field>
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Items</legend>
                {!lines.length ? (
                  <p className="rounded-md border border-dashed border-border-strong p-4 text-center text-sm text-muted-foreground">Pick products from the list to add them.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th scope="col" className="py-1">Product</th>
                        <th scope="col" className="w-20 py-1">Qty</th>
                        {channel === "self_checkout" && <th scope="col" className="w-24 py-1">Detected</th>}
                        <th scope="col" className="py-1 text-right">Line</th>
                        <th scope="col"><span className="sr-only">Remove</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={l.product_id} className="border-t border-border">
                          <td className="py-1.5 pr-2">{l.name}</td>
                          <td className="py-1.5 pr-2">
                            <Input type="number" min={1} aria-label={`Quantity for ${l.name}`} value={l.quantity} onChange={(e) => update(i, { quantity: Number(e.target.value) })} className="h-8" />
                          </td>
                          {channel === "self_checkout" && (
                            <td className="py-1.5 pr-2">
                              <Input type="number" min={0} aria-label={`Detected quantity for ${l.name}`} placeholder="="
                                value={l.detected_quantity ?? ""} onChange={(e) => update(i, { detected_quantity: e.target.value === "" ? null : Number(e.target.value) })} className="h-8" />
                            </td>
                          )}
                          <td className="tabular py-1.5 text-right">{formatCurrency(l.price * l.quantity)}</td>
                          <td className="py-1.5 text-right">
                            <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                              <Trash2 />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border font-semibold">
                        <td colSpan={channel === "self_checkout" ? 3 : 2} className="py-1.5">Charged total</td>
                        <td className="tabular py-1.5 text-right">{formatCurrency(total)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                )}
                {channel === "self_checkout" && lines.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">“Detected” is the bagging-scale count; leave empty if it matches the charged quantity.</p>
                )}
              </fieldset>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <Button type="submit" loading={submit.isPending} className="self-start">Submit simulated transaction</Button>
            </form>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Add products</CardTitle>
            </CardHeader>
            <CardContent>
              <ProductPicker
                onSelect={(p) => setLines((ls) => (ls.some((l) => l.product_id === p.id) ? ls.map((l) => (l.product_id === p.id ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { product_id: p.id, name: p.name, price: p.price, quantity: 1, detected_quantity: null }]))}
                listClassName="max-h-64"
              />
            </CardContent>
          </Card>
          {result && (
            <Card aria-live="polite">
              <CardHeader>
                <CardTitle>Result</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <KeyValue items={[
                  ["Receipt", <span className="font-mono">{result.receipt_number}</span>],
                  ["Transactions scored", result.scan.transactions_scored],
                  ["Alerts created", result.scan.alerts_created],
                  ["Alert threshold", result.scan.threshold],
                ]} />
                {result.alert ? (
                  <div className="rounded-md border border-danger/30 bg-danger-soft p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={result.alert.risk_level} />
                      <span className="tabular font-semibold">Risk {result.alert.risk_score.toFixed(1)}</span>
                    </div>
                    <p className="mt-1">{result.alert.summary}</p>
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => onOpenAlert(result.alert!.id)}>
                      <ExternalLink /> Open alert
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No alert: the transaction scored below the review threshold or fired no rules.</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
