import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CloudSun, CreditCard, Mail, MessageSquare, Pencil, Plug, Receipt, ShoppingBag, Smartphone, Tags } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue, PageHeader } from "@/components/ui/data";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Callout, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useAuth } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import { formatDateTime, titleCase } from "@/lib/utils";

import { Disclosure, GuardrailError, JsonBlock } from "./components/common";
import type { Integration } from "./types";

const META: Record<string, { label: string; icon: typeof Plug; purpose: string; live: string }> = {
  weather: { label: "Weather", icon: CloudSun, purpose: "Forecasts for weather-triggered promotions.", live: "Set WEATHER_PROVIDER=openweathermap and OPENWEATHER_API_KEY in the backend environment." },
  pricing_publisher: { label: "Shelf labels & POS prices", icon: Tags, purpose: "Publishes approved price changes to electronic shelf labels / POS.", live: "Simulated only: a real ESL/POS adapter must implement the publisher interface." },
  pos: { label: "Point of sale", icon: Receipt, purpose: "Transactions and coupon redemption at the till.", live: "Simulated only: connect a POS integration to ingest live transactions." },
  ecommerce: { label: "E-commerce feed", icon: ShoppingBag, purpose: "Online catalog and price feed.", live: "Simulated only: no live e-commerce connector is bundled." },
  payments: { label: "Payments", icon: CreditCard, purpose: "Payment gateway events used for fraud signals.", live: "Simulated only: no live payment gateway is bundled." },
  email: { label: "Email", icon: Mail, purpose: "Staff and shopper email notifications.", live: "Set EMAIL_PROVIDER=smtp plus SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD." },
  sms: { label: "SMS", icon: MessageSquare, purpose: "Text-message notifications.", live: "Messages are written to the log; a live SMS provider is not bundled." },
  push: { label: "Push notifications", icon: Smartphone, purpose: "Mobile/web push for proximity offers.", live: "Messages are written to the log; a live push provider is not bundled." },
  ai: { label: "AI provider", icon: Bot, purpose: "Assistant, list parsing and embeddings.", live: "Set AI_PROVIDER=openai or gemini and the matching API key." },
};

function ModeBadge({ mode }: { mode: string }) {
  const v = mode === "live" ? "success" : mode === "disabled" ? "neutral" : "accent";
  return <Badge variant={v}>{titleCase(mode)}</Badge>;
}

export default function IntegrationsPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ["merchant", "integrations"], queryFn: () => api.get<Integration[]>("/merchant/integrations") });
  const [editing, setEditing] = React.useState<Integration | null>(null);
  return (
    <div>
      <PageHeader title="Integrations" eyebrow="Administration" description="Connections to external systems. Most run in simulated mode for this demo; secrets are only ever read from environment variables, never stored here." />
      <Callout tone="simulated" className="mb-4" title="Simulated integrations are clearly labelled">
        POS, payments, e-commerce feed, shelf-label publishing, SMS and push use deterministic simulators that contact no external system. Live mode needs the environment configuration listed on each
        card.
      </Callout>
      {q.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(q.data ?? []).map((i) => {
            const meta = META[i.kind] ?? { label: titleCase(i.kind), icon: Plug, purpose: "", live: "" };
            const Icon = meta.icon;
            return (
              <Card key={i.kind} className="flex flex-col">
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="rounded-md bg-primary-soft p-2 text-primary">
                      <Icon className="size-4" aria-hidden />
                    </div>
                    <div>
                      <CardTitle>{meta.label}</CardTitle>
                      <p className="text-xs text-muted-foreground">{meta.purpose}</p>
                    </div>
                  </div>
                  <ModeBadge mode={i.mode} />
                </CardHeader>
                <CardContent className="flex-1 space-y-3">
                  <KeyValue
                    items={[
                      ["Active provider", i.active_provider],
                      ["Configured", i.configured_provider ?? "default"],
                      ["Available", i.providers.join(", ")],
                      ["Live capable", i.live_capable ? <Badge variant="success">Yes</Badge> : <Badge>No</Badge>],
                      ["Status", i.status],
                      ["Last updated", formatDateTime(i.last_checked_at)],
                    ]}
                  />
                  {!i.live_capable && <p className="text-xs text-muted-foreground">{meta.live}</p>}
                  {i.env_vars.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">Environment variables</p>
                      <div className="flex flex-wrap gap-1">
                        {i.env_vars.map((v) => (
                          <code key={v} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {v}
                          </code>
                        ))}
                      </div>
                    </div>
                  )}
                  {i.details && (
                    <Disclosure label="Provider details">
                      <JsonBlock value={i.details} />
                    </Disclosure>
                  )}
                  {Object.keys(i.settings ?? {}).length > 0 && (
                    <Disclosure label="Settings">
                      <JsonBlock value={i.settings} />
                    </Disclosure>
                  )}
                </CardContent>
                {can("integrations.manage") && (
                  <CardFooter className="justify-end">
                    <Button size="sm" variant="outline" onClick={() => setEditing(i)}>
                      <Pencil /> Configure
                    </Button>
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={editing ? `Configure ${META[editing.kind]?.label ?? editing.kind}` : "Configure"} description="Non-secret settings only. API keys and passwords are read from environment variables." size="lg">
          {editing && <IntegrationForm integration={editing} onDone={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const SECRET_KEYS = ["api_key", "password", "secret", "token"];

/** Validates the settings editor text: must be a JSON object without secret keys. Returns an error or null. */
export function validateSettingsJson(text: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text || "{}");
  } catch {
    return "Settings must be valid JSON";
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "Settings must be a JSON object";
  const bad = Object.keys(v).filter((k) => SECRET_KEYS.includes(k.toLowerCase()));
  if (bad.length) return `Secrets (${bad.join(", ")}) must be set through environment variables, not here`;
  return null;
}

function IntegrationForm({ integration, onDone }: { integration: Integration; onDone: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = React.useState(integration.mode);
  const [provider, setProvider] = React.useState(integration.configured_provider ?? integration.providers[0] ?? "");
  const [text, setText] = React.useState(JSON.stringify(integration.settings ?? {}, null, 2));
  const [touched, setTouched] = React.useState(false);
  const jsonError = validateSettingsJson(text);

  const parsed = (): Record<string, unknown> => (jsonError ? {} : (JSON.parse(text || "{}") as Record<string, unknown>));
  const failSkus = Array.isArray(parsed().fail_skus) ? (parsed().fail_skus as string[]).join(", ") : "";
  const setFailSkus = (s: string) => {
    const obj = parsed();
    obj.fail_skus = s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean);
    setText(JSON.stringify(obj, null, 2));
  };

  const m = useMutation({
    mutationFn: () => api.put(`/merchant/integrations/${integration.kind}`, { mode, provider: provider || null, settings: parsed() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["merchant", "integrations"] });
      if (integration.kind === "weather") void qc.invalidateQueries({ queryKey: ["merchant", "pricing", "weather"] });
      toast.success("Integration updated");
      onDone();
    },
  });

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!jsonError) m.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mode" htmlFor="int-mode" hint={mode === "live" && !integration.live_capable ? "Live mode needs environment configuration; until then the simulator stays active." : undefined}>
          <Select id="int-mode" value={mode} onChange={(e) => setMode(e.target.value as Integration["mode"])}>
            <option value="simulated">Simulated</option>
            <option value="live">Live</option>
            <option value="disabled">Disabled</option>
          </Select>
        </Field>
        <Field label="Provider" htmlFor="int-provider">
          <Select id="int-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {integration.providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {integration.kind === "pricing_publisher" && (
        <Field label="Fail SKUs (comma separated)" htmlFor="int-fail" hint="The simulated shelf-label controller rejects these SKUs, so you can exercise the FAILED publication state and retry.">
          <Input id="int-fail" value={failSkus} onChange={(e) => setFailSkus(e.target.value)} placeholder="e.g. BKY-002, DRY-004" disabled={!!jsonError} />
        </Field>
      )}
      {integration.kind === "pricing_publisher" && mode === "disabled" && <Callout tone="warning">While disabled, every publication attempt fails.</Callout>}
      {integration.kind === "weather" && (
        <Callout tone="simulated">
          Use <code className="font-mono">forecast_overrides</code> to script the simulated forecast per store code and date, e.g.{" "}
          <code className="font-mono text-xs">{'{"forecast_overrides": {"AND01": {"2026-10-20": {"precipitation_mm": 18, "condition": "rain"}}}}'}</code>
        </Callout>
      )}
      <Field label="Settings (JSON object)" htmlFor="int-settings" error={touched || text !== JSON.stringify(integration.settings ?? {}, null, 2) ? (jsonError ?? undefined) : undefined}>
        <Textarea id="int-settings" rows={10} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!jsonError} spellCheck={false} />
      </Field>
      <GuardrailError error={m.error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={m.isPending} disabled={!!jsonError}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
