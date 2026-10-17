import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Globe, KeyRound, Monitor, Smartphone } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";

import { StepShell, type StepNav } from "../components/StepShell";
import { useRefreshSetup } from "../onboarding-api";
import type { ApiKeyCreated } from "../types";

const CHANNELS = [
  {
    icon: Monitor,
    title: "Billing counter (POS)",
    text: "Your billing software sends each bill to the Orders API with an API key. Stock and dashboards update as bills are rung up.",
    badge: null,
  },
  {
    icon: Globe,
    title: "Online store",
    text: "Point a Shopify order webhook, or your own website's checkout, at OmniPulse so online orders count too.",
    badge: null,
  },
  {
    icon: Smartphone,
    title: "OmniPulse shopper app",
    text: "Shoppers find your store, build lists, navigate the aisles and place click & collect orders.",
    badge: "Enabled automatically",
  },
];

interface Props extends StepNav {
  storeId: string;
  done: boolean;
  apiKeys?: number;
}

export function ChannelsStep({ storeId, done, apiKeys, onBack, onNext }: Props) {
  const refresh = useRefreshSetup();
  const [key, setKey] = React.useState<ApiKeyCreated | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<ApiKeyCreated>("/merchant/channels/keys", { name: "Counter 1 billing", channel: "pos", provider: "generic", store_id: storeId }),
    onSuccess: (k) => {
      setKey(k);
      toast.success("POS API key created", { description: "Copy the secret now; it is shown only once." });
      refresh(["merchant", "channels"]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <StepShell
      title="Connect your sales channels"
      description="Every bill from every channel flows into one live view of stock, sales and shopper demand."
      done={done}
      onBack={onBack}
      onNext={onNext}
    >
      <ul className="grid gap-3 md:grid-cols-3">
        {CHANNELS.map((c) => (
          <li key={c.title} className="flex flex-col gap-2 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              <c.icon className="size-4 text-primary" aria-hidden /> {c.title}
            </div>
            <p className="text-sm text-muted-foreground">{c.text}</p>
            {c.badge && (
              <Badge variant="success" className="self-start">
                <Check className="size-3" aria-hidden /> {c.badge}
              </Badge>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="flex items-center gap-2 font-medium">
              <KeyRound className="size-4 text-primary" aria-hidden /> Connect your billing counter
            </p>
            <p className="text-sm text-muted-foreground">
              {apiKeys ? `${apiKeys} active API key${apiKeys === 1 ? "" : "s"}. ` : ""}Create a key for your POS and paste it into the billing software's integration settings.
            </p>
          </div>
          <Button onClick={() => create.mutate()} loading={create.isPending}>
            <KeyRound /> Create POS API key
          </Button>
        </div>
        {key && <SecretBox secret={key.secret} name={key.name} />}
        <p className="text-sm text-muted-foreground">
          Webhook URLs, Shopify setup, key management and a bill simulator are on the{" "}
          <Link to="/merchant/channels" className="font-medium text-primary hover:underline">
            Channels page
          </Link>
          .
        </p>
      </div>
    </StepShell>
  );
}

function SecretBox({ secret, name }: { secret: string; name: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success("API key copied");
    } catch {
      toast.error("Could not copy automatically; select the key and copy it");
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning-soft p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-warning">
        <AlertTriangle className="size-4 shrink-0" aria-hidden /> Copy this key now. It won't be shown again.
      </p>
      <p className="text-xs text-foreground/80">{name}</p>
      <div className="flex items-stretch gap-2">
        <code aria-label="API key secret" className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs">
          {secret}
        </code>
        <Button variant="outline" size="icon" aria-label="Copy API key" onClick={() => void copy()} className="h-auto">
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
