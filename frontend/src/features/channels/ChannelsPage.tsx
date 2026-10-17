/** Channels & connectors: plug the POS and the online store into one stock and pricing brain. */
import { useQuery } from "@tanstack/react-query";
import {
  CreditCard,
  FileSpreadsheet,
  FlaskConical,
  Globe,
  IndianRupee,
  KeyRound,
  Plug,
  Receipt,
  ScanLine,
  ShoppingBag,
  Smartphone,
  Store,
  Tags,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, StatCard } from "@/components/ui/data";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";

import { ApiKeysCard } from "./ApiKeysCard";
import { CHANNELS_KEY } from "./channel-meta";
import { DeveloperQuickStart } from "./DeveloperQuickStart";
import { LiveOrdersFeed } from "./LiveOrdersFeed";
import { PosSimulator } from "./PosSimulator";
import type { ChannelsOverview, Connector, SalesChannel } from "./types";

const CONNECTOR_ICON: Record<string, LucideIcon> = {
  pos_api: Receipt,
  pos_simulator: FlaskConical,
  shopify: ShoppingBag,
  storefront_api: Globe,
  omnipulse_app: Smartphone,
  sales_csv: FileSpreadsheet,
  payments: CreditCard,
  shelf_labels: Tags,
};

const AUTH_LABEL: Record<Connector["auth"], string> = { api_key: "API key", session: "Staff sign-in", none: "Automatic" };

const GROUPS: { title: string; icon: LucideIcon; match: (c: Connector) => boolean }[] = [
  { title: "In-store", icon: Store, match: (c) => c.channel === "pos" || c.channel === "self_checkout" },
  { title: "Online", icon: Globe, match: (c) => c.channel === "online" || c.channel === "ecommerce" },
  { title: "Other", icon: Plug, match: (c) => !["pos", "self_checkout", "online", "ecommerce"].includes(c.channel) },
];

const STAT_CHANNELS: { channel: SalesChannel; label: string; icon: LucideIcon }[] = [
  { channel: "pos", label: "POS counter today", icon: Receipt },
  { channel: "self_checkout", label: "Self-checkout today", icon: ScanLine },
  { channel: "online", label: "Online today", icon: Globe },
];

export default function ChannelsPage() {
  const { storeId, stores, concreteStoreId } = useMerchantStore();
  const q = useQuery({ queryKey: CHANNELS_KEY, queryFn: () => api.get<ChannelsOverview>("/merchant/channels") });
  const storeCode = stores.find((s) => s.id === concreteStoreId)?.code ?? stores[0]?.code ?? "AND01";

  return (
    <div>
      <PageHeader
        eyebrow="Connect"
        title="Channels & connectors"
        description="Plug your POS, self-checkout and online store into one stock and pricing brain: every sale updates inventory, expiry exposure and forecasts in seconds, and every channel sells at the same approved price."
        actions={q.data && <Badge variant={q.data.realtime === "firestore" ? "success" : "neutral"}>{q.data.realtime === "firestore" ? "Real-time: Firestore" : "Real-time: polling"}</Badge>}
      />

      {q.isLoading ? (
        <div className="space-y-6" aria-busy="true" aria-label="Loading channels">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data ? (
        <div className="space-y-6">
          <TodayStats today={q.data.today} />
          <ConnectorGroups connectors={q.data.connectors} />
          <div className="grid items-start gap-4 xl:grid-cols-5">
            <PosSimulator className="xl:col-span-3" />
            <LiveOrdersFeed storeId={storeId} className="xl:col-span-2" />
          </div>
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <ApiKeysCard keys={q.data.keys} />
            <DeveloperQuickStart endpoints={q.data.endpoints} storeCode={storeCode} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TodayStats({ today }: { today: ChannelsOverview["today"] }) {
  const totalOrders = STAT_CHANNELS.reduce((s, c) => s + (today[c.channel]?.orders ?? 0), 0);
  const totalRevenue = STAT_CHANNELS.reduce((s, c) => s + (today[c.channel]?.revenue ?? 0), 0);
  return (
    <section aria-label="Today by channel" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {STAT_CHANNELS.map((c) => (
        <StatCard
          key={c.channel}
          label={c.label}
          value={`${formatNumber(today[c.channel]?.orders ?? 0)} orders`}
          icon={c.icon}
          hint={`${formatCurrency(today[c.channel]?.revenue ?? 0, { whole: true })} revenue`}
        />
      ))}
      <StatCard label="All channels today" value={formatCurrency(totalRevenue, { whole: true })} icon={IndianRupee} tone="success" hint={`${formatNumber(totalOrders)} orders across every channel`} />
    </section>
  );
}

function ConnectorGroups({ connectors }: { connectors: Connector[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {GROUPS.map((g) => {
        const items = connectors.filter(g.match);
        if (!items.length) return null;
        const GroupIcon = g.icon;
        return (
          <Card key={g.title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GroupIcon className="size-4 text-primary" aria-hidden /> {g.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {items.map((c) => {
                  const Icon = CONNECTOR_ICON[c.key] ?? Plug;
                  return (
                    <li key={c.key} className="flex items-start gap-3 rounded-md border border-border p-3">
                      <div className="rounded-md bg-primary-soft p-2 text-primary">
                        <Icon className="size-4" aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium">{c.name}</span>
                          <Badge variant={c.mode === "live" ? "success" : "accent"}>{c.mode === "live" ? "Live" : "Simulated"}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{c.description}</p>
                        <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <KeyRound className="size-3" aria-hidden /> {AUTH_LABEL[c.auth] ?? c.auth}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
