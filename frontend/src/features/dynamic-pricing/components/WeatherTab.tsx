import { useQuery } from "@tanstack/react-query";
import { CloudRain, CloudSun, Sun, Umbrella } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Provenance } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { Check } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatNumber, titleCase } from "@/lib/utils";

import type { Promotion, WeatherOpportunities } from "../types";
import { PromotionFormDialog, type PromotionPrefill } from "./PromotionFormDialog";

const CHECK_LABELS: [keyof WeatherOpportunities["candidates"][number]["checks"], string][] = [
  ["rain_forecast", "Rain forecast"],
  ["historical_association", "Sells more on rainy days"],
  ["stock_sufficient", "Stock sufficient"],
  ["promotion_eligible", "Promotion-eligible"],
  ["above_price_floor", "Above price floor"],
];

export function WeatherTab({ onPromotionCreated }: { onPromotionCreated: (p: Promotion) => void }) {
  const { stores, concreteStoreId } = useMerchantStore();
  const { can } = useAuth();
  const [storeId, setStoreId] = React.useState<string | null>(concreteStoreId);
  React.useEffect(() => {
    if (!storeId && concreteStoreId) setStoreId(concreteStoreId);
  }, [concreteStoreId, storeId]);
  const [prefill, setPrefill] = React.useState<PromotionPrefill | null>(null);

  const q = useQuery({
    queryKey: ["merchant", "pricing", "weather", storeId],
    queryFn: () => api.get<WeatherOpportunities>("/merchant/pricing/weather-opportunities", { store_id: storeId }),
    enabled: Boolean(storeId),
  });
  const d = q.data;
  const rec = d?.recommendation;

  const draft = () => {
    if (!d || !rec) return;
    const byId = new Map(d.candidates.map((c) => [c.product_id, c]));
    setPrefill({
      name: rec.name,
      description: rec.rationale,
      store_id: d.store_id,
      products: rec.product_ids.map((id) => ({ id, name: byId.get(id)?.name ?? id, sku: byId.get(id)?.sku, price: byId.get(id)?.regular_price })),
      promo_type: "percent_off",
      discount_value: rec.discount_pct,
      starts_at: rec.starts_at,
      ends_at: rec.ends_at,
      geofence_radius_m: rec.geofence_radius_m,
      trigger: "weather",
      evidence: {
        rain_days: d.rain_days,
        weather_source: d.weather_source,
        method: d.method,
        candidates: d.candidates.filter((c) => c.qualifies).map((c) => ({ sku: c.sku, ...c.evidence })),
      },
    });
  };

  return (
    <div className="space-y-4">
      <Callout title="Association, not causation">
        A product qualifies only if rain (≥ 5 mm) is forecast, it historically sold at least 30% more on rainy days at this store (with at least 5 rainy and 5 dry days observed), stock covers expected
        demand (scarce stock is never discounted) and the promo price stays above the floor. Rainy-day sales are a correlation; drafts still need approval before going live.
      </Callout>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="wx-store" className="text-sm text-muted-foreground">
          Store
        </label>
        <Select id="wx-store" value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value || null)} className="w-64">
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </Select>
      </div>
      {!storeId ? (
        <EmptyState title="Choose a store" />
      ) : q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle>3-day forecast</CardTitle>
              <Provenance kind={d.weather_source === "simulated" ? "simulated" : "rule"} detail={`Weather source: ${d.weather_source}`} />
            </CardHeader>
            <CardContent>
              <ul className="grid gap-3 sm:grid-cols-3">
                {d.forecast.map((f) => {
                  const rainy = d.rain_days.includes(f.date);
                  const Icon = f.precipitation_mm >= 5 ? CloudRain : f.precipitation_mm > 0 ? CloudSun : Sun;
                  return (
                    <li key={f.date} className={cn("flex items-center gap-3 rounded-lg border p-3", rainy ? "border-info/40 bg-info-soft" : "border-border")}>
                      <Icon className={cn("size-6", rainy ? "text-info" : "text-warning")} aria-hidden />
                      <div className="min-w-0 text-sm">
                        <p className="font-medium">{formatDate(f.date, { weekday: "short" })}</p>
                        <p className="text-muted-foreground">
                          {titleCase(f.condition)} · {formatNumber(f.precipitation_mm, 1)} mm
                          {f.temp_max_c !== null && ` · ${Math.round(f.temp_min_c ?? 0)}–${Math.round(f.temp_max_c)}°C`}
                        </p>
                      </div>
                      <Badge variant={f.source === "simulated" ? "accent" : "info"} className="ml-auto">
                        {f.source}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {rec ? (
            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Umbrella className="size-4 text-primary" aria-hidden /> {rec.name}
                </CardTitle>
                <CardDescription>{rec.rationale}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  {rec.product_ids.length} product(s) · {rec.discount_pct}% off · {formatDate(rec.starts_at)} – {formatDate(rec.ends_at)} · geofence {formatNumber(rec.geofence_radius_m)} m
                </p>
                {can("pricing.recommend") && <Button onClick={draft}>Create promotion draft</Button>}
              </CardContent>
            </Card>
          ) : (
            <Callout tone="info" title="No promotion recommended">
              {d.rain_days.length === 0 ? "No rain is forecast for the next 3 days." : "No rain-tagged product passed every check."}
            </Callout>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Candidates</CardTitle>
              <CardDescription>Products tagged for rainy-day promotions, with the evidence behind each check ({d.discount_pct}% discount from the active rule).</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {d.candidates.length === 0 ? (
                <EmptyState className="mx-5" title="No candidate products" description="Tag products with the rule's product tag (e.g. 'rain') to evaluate them." />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Product</TH>
                      <TH className="text-right">Regular → promo</TH>
                      <TH className="text-right">Floor</TH>
                      <TH className="text-right">Stock / expected 3d</TH>
                      <TH>Historical evidence</TH>
                      <TH>Checks</TH>
                      <TH>Qualifies</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.candidates.map((c) => (
                      <TR key={c.product_id}>
                        <TD>
                          <div className="font-medium">{c.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">{c.sku}</div>
                        </TD>
                        <TD className="tabular whitespace-nowrap text-right">
                          {formatCurrency(c.regular_price)} → {formatCurrency(c.promo_price)}
                        </TD>
                        <TD className="tabular text-right text-muted-foreground">{formatCurrency(c.floor_price)}</TD>
                        <TD className="tabular text-right">
                          {formatNumber(c.stock)} / {formatNumber(c.expected_units_3d, 1)}
                        </TD>
                        <TD className="text-xs">
                          <div>
                            {formatNumber(c.evidence.avg_units_rain, 2)}/day on {c.evidence.rain_days_observed} rainy days
                          </div>
                          <div>
                            vs {formatNumber(c.evidence.avg_units_dry, 2)}/day on {c.evidence.dry_days_observed} dry days
                          </div>
                          <div className="font-medium">ratio {c.evidence.ratio ?? "—"}×</div>
                        </TD>
                        <TD>
                          <div className="flex min-w-48 flex-col gap-0.5">
                            {CHECK_LABELS.map(([k, label]) => (
                              <Check key={k} ok={c.checks[k]} label={label} />
                            ))}
                          </div>
                        </TD>
                        <TD>{c.qualifies ? <Badge variant="success">Qualifies</Badge> : <Badge>No</Badge>}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
      <PromotionFormDialog
        open={prefill !== null}
        onOpenChange={(o) => !o && setPrefill(null)}
        prefill={prefill ?? undefined}
        onCreated={(p) => {
          setPrefill(null);
          onPromotionCreated(p);
        }}
      />
    </div>
  );
}
