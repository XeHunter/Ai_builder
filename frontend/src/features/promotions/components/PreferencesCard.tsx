import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/menu";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";

import type { Preferences } from "../types";

export const PREFS_KEY = ["me", "preferences"] as const;

export function usePreferences() {
  return useQuery({ queryKey: PREFS_KEY, queryFn: () => api.get<Preferences>("/me/preferences") });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Preferences>) => api.patch<Preferences>("/me/preferences", patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: PREFS_KEY });
      const prev = qc.getQueryData<Preferences>(PREFS_KEY);
      if (prev) qc.setQueryData(PREFS_KEY, { ...prev, ...patch });
      return { prev };
    },
    onError: (e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
      toast.error(errorMessage(e));
    },
    onSuccess: (data) => {
      qc.setQueryData(PREFS_KEY, data);
      toast.success("Preferences saved");
    },
  });
}

const CHANNELS: { key: keyof Preferences; label: string; hint: string }[] = [
  { key: "in_app_enabled", label: "In-app notifications", hint: "The bell and notifications page." },
  { key: "email_enabled", label: "Email", hint: "Delivery is simulated in this demo." },
  { key: "sms_enabled", label: "SMS", hint: "Delivery is simulated in this demo." },
  { key: "push_enabled", label: "Push", hint: "Requires the native app; simulated here." },
];

const CONSENTS: { key: keyof Preferences; label: string; hint: string }[] = [
  { key: "marketing_opt_in", label: "Offers & promotions", hint: "Receive personalised and nearby offers." },
  { key: "location_consent", label: "Use my location", hint: "Lets us check if you're near a store to send nearby offers and reminders." },
  { key: "abandoned_list_reminders", label: "List reminders", hint: "Remind me about unfinished lists when I'm near the store." },
];

const COOLDOWNS = [15, 30, 60, 120, 240, 480, 720, 1440, 4320, 10080];

function cooldownLabel(min: number): string {
  if (min < 60) return `${min} minutes`;
  if (min < 1440) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${min / 1440} day${min === 1440 ? "" : "s"}`;
}

export function PreferencesCard() {
  const prefs = usePreferences();
  const update = useUpdatePreferences();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications & privacy</CardTitle>
        <CardDescription>Choose how we contact you and what you consent to. Changes save instantly.</CardDescription>
      </CardHeader>
      <CardContent>
        {prefs.isLoading ? (
          <SkeletonRows rows={6} />
        ) : prefs.isError ? (
          <ErrorState error={prefs.error} onRetry={() => prefs.refetch()} />
        ) : prefs.data ? (
          <div className="space-y-5">
            <ToggleGroup title="Channels" rows={CHANNELS} prefs={prefs.data} onChange={(k, v) => update.mutate({ [k]: v })} />
            <ToggleGroup title="Consent" rows={CONSENTS} prefs={prefs.data} onChange={(k, v) => update.mutate({ [k]: v })} />
            {prefs.data.location_consent && prefs.data.location_consent_at && (
              <p className="text-xs text-muted-foreground">Location consent given {formatDateTime(prefs.data.location_consent_at)}.</p>
            )}
            <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <span className="block font-medium">Quiet period between messages</span>
                <span className="text-xs text-muted-foreground">We won't send marketing notifications more often than this.</span>
              </span>
              <Select
                className="w-40"
                value={prefs.data.cooldown_minutes}
                onChange={(e) => update.mutate({ cooldown_minutes: Number(e.target.value) })}
                aria-label="Quiet period between messages"
              >
                {[...new Set([...COOLDOWNS, prefs.data.cooldown_minutes])].sort((a, b) => a - b).map((m) => (
                  <option key={m} value={m}>
                    {cooldownLabel(m)}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ToggleGroup({
  title,
  rows,
  prefs,
  onChange,
}: {
  title: string;
  rows: { key: keyof Preferences; label: string; hint: string }[];
  prefs: Preferences;
  onChange: (key: keyof Preferences, value: boolean) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</legend>
      <div className="divide-y divide-border rounded-md border border-border">
        {rows.map((r) => {
          const id = `pref-${r.key}`;
          return (
            <div key={r.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
                <span className="block font-medium">{r.label}</span>
                <span className="text-xs text-muted-foreground">{r.hint}</span>
              </label>
              <Switch id={id} checked={Boolean(prefs[r.key])} onCheckedChange={(v) => onChange(r.key, v)} />
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
