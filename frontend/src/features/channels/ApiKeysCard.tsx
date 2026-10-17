/** Connector API keys: list, create (secret shown once) and revoke. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, EmptyState } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { ConfirmDialog, GuardrailError } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime, formatNumber, timeAgo, titleCase } from "@/lib/utils";

import { CHANNELS_KEY } from "./channel-meta";
import { CopyButton } from "./CopyButton";
import type { ApiKeyCreated, ApiKeyView, KeyChannel, KeyProvider } from "./types";

const KEY_CHANNELS: { value: KeyChannel; label: string }[] = [
  { value: "pos", label: "POS / billing" },
  { value: "ecommerce", label: "E-commerce / website" },
  { value: "payments", label: "Payments" },
  { value: "other", label: "Other" },
];
const PROVIDERS: { value: KeyProvider; label: string }[] = [
  { value: "generic", label: "Generic (Orders API)" },
  { value: "shopify", label: "Shopify" },
  { value: "woocommerce", label: "WooCommerce" },
  { value: "custom", label: "Custom app" },
];

export function ApiKeysCard({ keys, className }: { keys: ApiKeyView[]; className?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can("integrations.manage");
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiKeyView | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/merchant/channels/keys/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      toast.success("API key revoked");
      setRevoking(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const active = keys.filter((k) => !k.revoked);
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden /> API keys
          </CardTitle>
          <CardDescription>
            {active.length} active key{active.length === 1 ? "" : "s"}. POS software and storefronts send one in the <code className="font-mono text-xs">X-Api-Key</code> header.
          </CardDescription>
        </div>
        {manage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> Create key
          </Button>
        )}
      </CardHeader>
      <CardContent className="px-0">
        {keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            className="mx-5"
            title="No API keys yet"
            description={manage ? "Create a key for your billing software or online store to start streaming orders." : "Ask an administrator to create a connector key."}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Key</TH>
                <TH>Store</TH>
                <TH className="text-right">Usage</TH>
                <TH>Last used</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {keys.map((k) => (
                <TR key={k.id} className={k.revoked ? "opacity-60" : undefined}>
                  <TD>
                    <p className="font-medium">{k.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(k.provider)} · {titleCase(k.channel)} · created {formatDateTime(k.created_at)}
                    </p>
                  </TD>
                  <TD>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{k.prefix}…</code>
                  </TD>
                  <TD>{k.store_code ?? <span className="text-muted-foreground">All stores</span>}</TD>
                  <TD className="tabular text-right">{formatNumber(k.usage_count)}</TD>
                  <TD className="text-muted-foreground" title={formatDateTime(k.last_used_at)}>
                    {k.last_used_at ? timeAgo(k.last_used_at) : "Never"}
                  </TD>
                  <TD className="text-right">
                    {k.revoked ? (
                      <Badge>Revoked</Badge>
                    ) : manage ? (
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>
                        <Trash2 aria-hidden /> Revoke
                      </Button>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="Create API key" description="Give each POS terminal or storefront its own key so you can revoke it independently." size="md">
          {creating && <CreateKeyForm onDone={() => setCreating(false)} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke API key?"
        description={revoking ? `"${revoking.name}" (${revoking.prefix}…) stops working immediately. Systems using it will get 401 errors.` : undefined}
        confirmLabel="Revoke key"
        destructive
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </Card>
  );
}

function CreateKeyForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { stores } = useMerchantStore();
  const [name, setName] = React.useState("");
  const [channel, setChannel] = React.useState<KeyChannel>("pos");
  const [provider, setProvider] = React.useState<KeyProvider>("generic");
  const [storeId, setStoreId] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const nameError = name.trim().length < 2 ? "Enter a name (2+ characters)" : name.trim().length > 80 ? "At most 80 characters" : null;

  const m = useMutation({
    mutationFn: () => api.post<ApiKeyCreated>("/merchant/channels/keys", { name: name.trim(), channel, provider, store_id: storeId || undefined }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHANNELS_KEY }),
  });

  if (m.data) {
    return (
      <div className="space-y-4">
        <Callout tone="warning" title="Copy this key now">
          This is the only time the full key is shown. We store only a hash, so it cannot be recovered later.
        </Callout>
        <Field label={`Secret for "${m.data.name}"`} htmlFor="key-secret">
          <div className="flex gap-2">
            <Input id="key-secret" readOnly value={m.data.secret} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={m.data.secret} label="Copy API key" />
          </div>
        </Field>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Keep it server-side (POS sync agent, webhook config). Never embed it in a public website.
        </p>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!nameError) m.mutate();
      }}
    >
      <Field label="Name" htmlFor="key-name" error={touched && nameError ? nameError : undefined} hint="e.g. Andheri till 1, Shopify store">
        <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-invalid={touched && !!nameError} autoFocus />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Channel" htmlFor="key-channel">
          <Select id="key-channel" value={channel} onChange={(e) => setChannel(e.target.value as KeyChannel)}>
            {KEY_CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Provider" htmlFor="key-provider">
          <Select id="key-provider" value={provider} onChange={(e) => setProvider(e.target.value as KeyProvider)}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Store" htmlFor="key-store" hint="Pin the key to one store, or leave it open and send store_code with each order.">
        <Select id="key-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
          <option value="">All stores (store_code per request)</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <GuardrailError error={m.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={m.isPending}>
          Create key
        </Button>
      </DialogFooter>
    </form>
  );
}
