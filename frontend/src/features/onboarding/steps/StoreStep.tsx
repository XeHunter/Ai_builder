import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { LocateFixed, MapPin, Plus, Store } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { zNum } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";

import { StepShell, type StepNav } from "../components/StepShell";
import { useRefreshSetup } from "../onboarding-api";
import type { OnboardingStore } from "../types";

export const storeSchema = z.object({
  name: z.string().trim().min(2, "Enter the store name").max(120),
  address: z.string().trim().max(255),
  city: z.string().trim().max(80),
  latitude: zNum("Enter a latitude").min(-90, "Latitude is between -90 and 90").max(90, "Latitude is between -90 and 90"),
  longitude: zNum("Enter a longitude").min(-180, "Longitude is between -180 and 180").max(180, "Longitude is between -180 and 180"),
});
type StoreForm = z.infer<typeof storeSchema>;

const PUNE = { latitude: 18.5204, longitude: 73.8567 };

interface Props extends StepNav {
  stores: OnboardingStore[];
  storeId: string | null;
  onSelect: (id: string) => void;
  done: boolean;
}

export function StoreStep({ stores, storeId, onSelect, done, onBack, onNext }: Props) {
  const [adding, setAdding] = React.useState(false);
  const store = stores.find((s) => s.id === storeId) ?? null;
  const showForm = adding || stores.length === 0;

  return (
    <StepShell
      title="Store details"
      description="Your store's name and location. Shoppers nearby see it in the app, and it anchors navigation and reports."
      done={done}
      skippable={false}
      onBack={onBack}
      onNext={onNext}
    >
      {stores.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-md bg-primary-soft p-2 text-primary">
              <Store className="size-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="font-medium">{store?.name ?? "Choose a store"}</p>
              {store && (
                <p className="text-sm text-muted-foreground">
                  <span className="font-mono">{store.code}</span>
                  {store.city ? ` · ${store.city}` : ""}
                </p>
              )}
            </div>
          </div>
          {stores.length > 1 && (
            <Field label="Set up store" htmlFor="setup-store" className="sm:w-64">
              <Select id="setup-store" value={storeId ?? ""} onChange={(e) => onSelect(e.target.value)}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
      {showForm ? (
        <StoreForm
          onCancel={stores.length ? () => setAdding(false) : undefined}
          onCreated={(s) => {
            setAdding(false);
            onSelect(s.id);
          }}
        />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add another store
        </Button>
      )}
    </StepShell>
  );
}

function StoreForm({ onCreated, onCancel }: { onCreated: (s: OnboardingStore) => void; onCancel?: () => void }) {
  const refresh = useRefreshSetup();
  const [locating, setLocating] = React.useState(false);
  const form = useForm<StoreForm>({
    resolver: zodResolver(storeSchema),
    defaultValues: { name: "", address: "", city: "Pune", ...PUNE },
  });
  const errors = form.formState.errors;

  const create = useMutation({
    mutationFn: (v: StoreForm) => api.post<OnboardingStore>("/merchant/stores", v),
    onSuccess: (s) => {
      toast.success(`${s.name} created`, { description: `Store code ${s.code}` });
      refresh(["merchant", "stores"], ["stores"]);
      onCreated(s);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const locate = () => {
    if (!("geolocation" in navigator)) {
      toast.error("Location is not available in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        form.setValue("latitude", Number(pos.coords.latitude.toFixed(6)), { shouldValidate: true });
        form.setValue("longitude", Number(pos.coords.longitude.toFixed(6)), { shouldValidate: true });
        toast.success("Location filled in");
      },
      (err) => {
        setLocating(false);
        toast.error("Could not get your location", { description: err.message });
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4 sm:grid-cols-2" noValidate aria-label="New store">
      <Field label="Store name" htmlFor="store-name" error={errors.name?.message} className="sm:col-span-2">
        <Input id="store-name" placeholder="e.g. Sharma Fresh Mart, Kothrud" aria-invalid={!!errors.name} {...form.register("name")} />
      </Field>
      <Field label="Address" htmlFor="store-address" error={errors.address?.message} className="sm:col-span-2">
        <Input id="store-address" autoComplete="street-address" aria-invalid={!!errors.address} {...form.register("address")} />
      </Field>
      <Field label="City" htmlFor="store-city" error={errors.city?.message} className="sm:col-span-2">
        <Input id="store-city" autoComplete="address-level2" aria-invalid={!!errors.city} {...form.register("city")} />
      </Field>
      <Field label="Latitude" htmlFor="store-lat" error={errors.latitude?.message}>
        <Input id="store-lat" type="number" step="any" inputMode="decimal" aria-invalid={!!errors.latitude} {...form.register("latitude", { valueAsNumber: true })} />
      </Field>
      <Field label="Longitude" htmlFor="store-lng" error={errors.longitude?.message}>
        <Input id="store-lng" type="number" step="any" inputMode="decimal" aria-invalid={!!errors.longitude} {...form.register("longitude", { valueAsNumber: true })} />
      </Field>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="button" variant="outline" onClick={locate} loading={locating}>
          <LocateFixed /> Use my location
        </Button>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="size-3" aria-hidden /> Used to show your store to nearby shoppers.
        </span>
      </div>
      <div className="flex flex-wrap justify-end gap-2 sm:col-span-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={create.isPending}>
          Create store
        </Button>
      </div>
    </form>
  );
}
