/** Foreground location reports (simulated or real) that trigger nearby offers and list reminders. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Crosshair, MapPin, Navigation, ShieldAlert } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/feedback";
import { useShopperStore } from "@/hooks/use-stores";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatNumber } from "@/lib/utils";

import type { GeofenceAction, LocationResult } from "../types";
import { usePreferences, useUpdatePreferences } from "./PreferencesCard";

/** ~150 m north of a point (1° latitude ≈ 111 km). */
const NEAR_OFFSET_DEG = 150 / 111_000;
/** ~110 km away from every demo store. */
const FAR_OFFSET_DEG = 1;

const OUTCOME: Record<string, { label: string; variant: "success" | "neutral" | "warning" }> = {
  created: { label: "Notification sent", variant: "success" },
  duplicate: { label: "Already notified", variant: "neutral" },
  opted_out: { label: "Suppressed — opted out", variant: "warning" },
  cooldown: { label: "Suppressed — quiet period", variant: "warning" },
  already_issued: { label: "Coupon already issued", variant: "neutral" },
};

export function LocationSimulator({ onReported }: { onReported?: () => void }) {
  const { stores } = useShopperStore();
  const qc = useQueryClient();
  const prefs = usePreferences();
  const updatePrefs = useUpdatePreferences();
  const [result, setResult] = React.useState<LocationResult | null>(null);
  const [label, setLabel] = React.useState<string | null>(null);
  const [consentNeeded, setConsentNeeded] = React.useState(false);
  const [locating, setLocating] = React.useState(false);

  const report = useMutation({
    mutationFn: (v: { latitude: number; longitude: number; simulated: boolean; label: string }) =>
      api.post<LocationResult>("/me/location", { latitude: v.latitude, longitude: v.longitude, simulated: v.simulated }),
    onSuccess: (res, v) => {
      setConsentNeeded(false);
      setResult(res);
      setLabel(v.label);
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      onReported?.();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 403) {
        setConsentNeeded(true);
        setResult(null);
      } else toast.error(errorMessage(e));
    },
  });

  const shareRealLocation = () => {
    if (!("geolocation" in navigator)) {
      toast.error("Your browser doesn't support location.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        report.mutate({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, simulated: false, label: "Your real location" });
      },
      (err) => {
        setLocating(false);
        toast.error(err.code === err.PERMISSION_DENIED ? "Location permission was denied. Allow it in your browser settings to use your real location." : "Couldn't get your location. Try a simulated one instead.");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const consentOff = consentNeeded || prefs.data?.location_consent === false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Location simulator</CardTitle>
        <CardDescription>See what happens when you walk near a store.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Callout tone="simulated" title="Simulated geofencing">
          Real background geofencing needs a native mobile app. Here you report a location in the foreground — pick a simulated spot or share your real one.
        </Callout>

        {consentOff && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm">
            <span className="flex items-center gap-2 font-medium text-warning">
              <ShieldAlert className="size-4" aria-hidden /> Location consent is off
            </span>
            <span className="text-foreground/85">We only check your location with your permission. Turn on “Use my location” to try nearby offers.</span>
            <Button
              size="sm"
              className="self-start"
              loading={updatePrefs.isPending}
              onClick={() => updatePrefs.mutate({ location_consent: true }, { onSuccess: () => setConsentNeeded(false) })}
            >
              Enable location consent
            </Button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <Button
              key={s.id}
              variant="outline"
              size="sm"
              disabled={report.isPending}
              onClick={() =>
                report.mutate({ latitude: s.latitude + NEAR_OFFSET_DEG, longitude: s.longitude, simulated: true, label: `Near ${s.name}` })
              }
            >
              <MapPin aria-hidden /> Near {s.name}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={report.isPending || !stores.length}
            onClick={() => stores[0] && report.mutate({ latitude: stores[0].latitude + FAR_OFFSET_DEG, longitude: stores[0].longitude, simulated: true, label: "Far away" })}
          >
            <Navigation aria-hidden /> Far away
          </Button>
          <Button variant="ghost" size="sm" disabled={report.isPending} loading={locating} onClick={shareRealLocation}>
            <Crosshair aria-hidden /> Use my real location
          </Button>
        </div>

        {report.isPending && <p className="text-sm text-muted-foreground">Checking nearby stores…</p>}
        {result && <LocationResultView result={result} label={label} />}
      </CardContent>
    </Card>
  );
}

function LocationResultView({ result, label }: { result: LocationResult; label: string | null }) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3" aria-live="polite">
      <p className="text-sm font-medium">
        {label ?? "Location"} {result.simulated && <Badge variant="accent">Simulated</Badge>}
      </p>
      {result.results.length === 0 ? (
        <p className="text-sm text-muted-foreground">You're not inside any store's area — nothing to send. ({result.evaluated_stores} stores checked)</p>
      ) : (
        <ul className="space-y-2">
          {result.results.map((r) => (
            <li key={r.store} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{r.store}</span>
                <span className="tabular text-xs text-muted-foreground">{formatNumber(r.distance_m)} m away</span>
                <Badge variant={r.event === "enter" ? "success" : r.event === "exit" ? "neutral" : "info"}>
                  {r.event === "enter" ? "Entered area" : r.event === "exit" ? "Left area" : "Still nearby"}
                </Badge>
              </div>
              {r.actions.length > 0 ? (
                <ul className="mt-1 space-y-1 pl-3">
                  {r.actions.map((a, i) => (
                    <ActionRow key={i} action={a} />
                  ))}
                </ul>
              ) : (
                r.event !== "exit" && <p className="mt-1 pl-3 text-xs text-muted-foreground">No new offers or reminders.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionRow({ action }: { action: GeofenceAction }) {
  const outcomeKey = action.type === "offer" ? action.notification ?? action.outcome ?? "" : action.notification;
  const outcome = OUTCOME[outcomeKey] ?? (outcomeKey.startsWith("not_issued") ? { label: "Not issued", variant: "warning" as const } : null);
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      {action.type === "offer" ? (
        <>
          <span>Offer “{action.promotion}”</span>
          {action.coupon && <code className="rounded bg-muted px-1.5 py-0.5 font-mono font-semibold">{action.coupon}</code>}
        </>
      ) : (
        <span>
          Reminder for “{action.list}” ({action.pending_items} items left)
        </span>
      )}
      {outcome && <Badge variant={outcome.variant}>{outcome.label}</Badge>}
    </li>
  );
}
