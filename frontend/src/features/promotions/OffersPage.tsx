import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, MapPin, Tag, Ticket } from "lucide-react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/data";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { useShopperStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { formatCurrency, formatDate, titleCase } from "@/lib/utils";

import { LocationSimulator } from "./components/LocationSimulator";
import { PreferencesCard } from "./components/PreferencesCard";
import type { OffersResponse, ShopperPromotion } from "./types";

function discountLabel(p: ShopperPromotion): string {
  if (p.promo_type === "percent_off") return `${p.discount_value}% off`;
  if (p.promo_type === "amount_off" || p.promo_type === "fixed_off") return `${formatCurrency(p.discount_value)} off`;
  return titleCase(p.promo_type);
}

export default function OffersPage() {
  const { store, storeId } = useShopperStore();
  const qc = useQueryClient();
  const offersKey = ["store", storeId, "offers"];
  const offers = useQuery({
    queryKey: offersKey,
    queryFn: () => api.get<OffersResponse>("/offers", { store_id: storeId }),
    enabled: !!storeId,
  });

  const claim = useMutation({
    mutationFn: (id: string) => api.post<{ code: string; new: boolean; expires_at: string }>(`/offers/${id}/claim`),
    onSuccess: (res) => {
      toast.success(res.new ? `Coupon ${res.code} is yours` : `You already have coupon ${res.code}`);
      void qc.invalidateQueries({ queryKey: offersKey });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(`Copied ${code}`);
    } catch {
      toast.info(`Your code is ${code}`);
    }
  };

  const claimedPromos = new Set((offers.data?.coupons ?? []).filter((c) => c.status === "issued" || c.status === "active").map((c) => c.promotion));

  return (
    <div>
      <PageHeader eyebrow={store?.name} title="Offers & preferences" description="Active offers at this store, your coupons, and how we may contact you." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Active offers</CardTitle>
              <CardDescription>Claim a coupon and show the code at checkout.</CardDescription>
            </CardHeader>
            <CardContent>
              {offers.isLoading ? (
                <SkeletonRows rows={3} />
              ) : offers.isError ? (
                <ErrorState error={offers.error} onRetry={() => offers.refetch()} />
              ) : !offers.data?.promotions.length ? (
                <EmptyState icon={Tag} title="No active offers" description="Check back soon — new promotions appear here." />
              ) : (
                <ul className="space-y-3">
                  {offers.data.promotions.map((p) => (
                    <li key={p.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-start">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{p.name}</span>
                          <Badge variant="accent">{discountLabel(p)}</Badge>
                          {p.nearby_only && (
                            <Badge variant="info">
                              <MapPin className="size-3" aria-hidden /> Only near the store
                            </Badge>
                          )}
                        </div>
                        {p.description && <p className="mt-1 text-sm text-foreground/85">{p.description}</p>}
                        {p.products.length > 0 && <p className="mt-1 text-xs text-muted-foreground">On: {p.products.join(", ")}</p>}
                        <p className="mt-1 text-xs text-muted-foreground">Ends {formatDate(p.ends_at)}</p>
                      </div>
                      {p.nearby_only ? (
                        <p className="max-w-48 text-xs text-muted-foreground">Issued automatically when you're near the store (location consent required).</p>
                      ) : claimedPromos.has(p.name) ? (
                        <Badge variant="success" className="self-start">
                          Claimed
                        </Badge>
                      ) : (
                        <Button size="sm" className="self-start" loading={claim.isPending && claim.variables === p.id} onClick={() => claim.mutate(p.id)}>
                          Claim coupon
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>My coupons</CardTitle>
            </CardHeader>
            <CardContent>
              {offers.isLoading ? (
                <SkeletonRows rows={2} />
              ) : !offers.data?.coupons.length ? (
                <EmptyState icon={Ticket} title="No coupons yet" description="Claim an offer above or try the location simulator." />
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {offers.data.coupons.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                      <code className="rounded bg-muted px-2 py-1 font-mono text-sm font-semibold">{c.code}</code>
                      <span className="min-w-0 flex-1">
                        <span className="block">{c.promotion}</span>
                        <span className="text-xs text-muted-foreground">
                          {c.issued_via === "geofence" ? "Nearby offer" : "Claimed in app"} · expires {formatDate(c.expires_at)}
                        </span>
                      </span>
                      <StatusBadge status={c.status} />
                      <Button size="icon" variant="ghost" aria-label={`Copy coupon code ${c.code}`} onClick={() => void copy(c.code)}>
                        <Copy />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <LocationSimulator onReported={() => void qc.invalidateQueries({ queryKey: offersKey })} />
          <PreferencesCard />
        </div>
      </div>
    </div>
  );
}
