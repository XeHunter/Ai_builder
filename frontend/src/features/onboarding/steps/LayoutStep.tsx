import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, LayoutGrid } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { StoreMap } from "@/components/maps/StoreMap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/menu";
import { useDebouncedValue } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn, formatNumber } from "@/lib/utils";

import { StepShell, type StepNav } from "../components/StepShell";
import { useRefreshSetup } from "../onboarding-api";
import type { LayoutGenerateResult, LayoutPreview, LayoutSpec } from "../types";

export const DEFAULT_SPEC: LayoutSpec = { aisles: 6, sections: 4, levels: 5, checkouts: 3, dairy_wall: true, produce_wall: true, frozen_wall: true };

const RANGES: { key: "aisles" | "sections" | "levels" | "checkouts"; label: string; min: number; max: number; hint: string }[] = [
  { key: "aisles", label: "Aisles", min: 1, max: 12, hint: "Double-sided shelving runs" },
  { key: "sections", label: "Sections per aisle", min: 2, max: 8, hint: "Bays along each aisle" },
  { key: "levels", label: "Shelf levels", min: 2, max: 6, hint: "Shelves per bay, bottom to top" },
  { key: "checkouts", label: "Checkout counters", min: 1, max: 8, hint: "Billing counters near the exit" },
];

const WALLS: { key: "dairy_wall" | "produce_wall" | "frozen_wall"; label: string }[] = [
  { key: "dairy_wall", label: "Dairy chiller wall" },
  { key: "produce_wall", label: "Fruit & vegetable wall" },
  { key: "frozen_wall", label: "Frozen food wall" },
];

interface Props extends StepNav {
  storeId: string;
  storeName?: string;
  done: boolean;
}

export function LayoutStep({ storeId, storeName, done, onBack, onNext }: Props) {
  const refresh = useRefreshSetup();
  const [spec, setSpec] = React.useState<LayoutSpec>(DEFAULT_SPEC);
  const [saved, setSaved] = React.useState<LayoutGenerateResult | null>(null);
  const debounced = useDebouncedValue(spec, 300);

  const preview = useQuery({
    queryKey: ["merchant", "onboarding", "layout-preview", storeId, debounced],
    queryFn: () => api.post<LayoutPreview>(`/merchant/stores/${storeId}/layout-preview`, debounced),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const generate = useMutation({
    mutationFn: () => api.post<LayoutGenerateResult>(`/merchant/stores/${storeId}/layout-generate`, spec),
    onSuccess: (r) => {
      setSaved(r);
      if (r.status === "active") toast.success(`Floor plan v${r.version} is live`, { description: "Shopper navigation uses it right away." });
      else toast.success(`Floor plan saved as draft v${r.version}`, { description: "Publish it from Store layout." });
      refresh(["merchant", "layouts"], ["merchant", "layout"], ["store"]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const set = <K extends keyof LayoutSpec>(key: K, value: LayoutSpec[K]) => {
    setSaved(null);
    setSpec((s) => ({ ...s, [key]: value }));
  };
  const layout = preview.data;
  const stale = preview.isFetching || debounced !== spec;

  return (
    <StepShell
      title="Floor plan builder"
      description="Describe your floor and we generate the map, shelf locations and walkways that power in-store navigation and planograms. You can fine-tune it later in Store layout."
      done={done}
      onBack={onBack}
      onNext={onNext}
    >
      {done && !saved && (
        <Callout title="This store already has an active floor plan">
          Generating a new one replaces it if no products are placed yet; otherwise it is saved as a draft you can review and publish.
        </Callout>
      )}
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <fieldset className="flex flex-col gap-4" aria-label="Floor plan options">
          {RANGES.map((r) => (
            <RangeControl key={r.key} id={`spec-${r.key}`} label={r.label} hint={r.hint} min={r.min} max={r.max} value={spec[r.key]} onChange={(v) => set(r.key, v)} />
          ))}
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            {WALLS.map((w) => (
              <div key={w.key} className="flex items-center justify-between gap-3">
                <Label htmlFor={`spec-${w.key}`}>{w.label}</Label>
                <Switch id={`spec-${w.key}`} checked={spec[w.key]} onCheckedChange={(v) => set(w.key, v)} />
              </div>
            ))}
          </div>
        </fieldset>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            {layout ? (
              <>
                <Badge variant="outline">{formatNumber(layout.stats.area_m2)} m² floor</Badge>
                <Badge variant="outline">{formatNumber(layout.stats.shelf_locations)} shelf locations</Badge>
                <Badge variant="outline">{formatNumber(layout.stats.walk_nodes)} walkway nodes</Badge>
                <Badge variant="neutral">
                  {layout.stats.width_m} × {layout.stats.height_m} m
                </Badge>
              </>
            ) : null}
            {stale && <span className="text-xs text-muted-foreground">Updating preview…</span>}
          </div>
          {preview.isError && !layout ? (
            <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
          ) : !layout ? (
            <Skeleton className="aspect-[4/3] w-full" />
          ) : (
            <div className={cn("transition-opacity", stale && "opacity-60")}>
              <StoreMap layout={layout} ariaLabel={`Floor plan preview${storeName ? ` for ${storeName}` : ""}: ${spec.aisles} aisles, ${spec.checkouts} checkouts`} />
            </div>
          )}
          {preview.isError && layout && <p className="text-sm text-danger">{errorMessage(preview.error)}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {saved && (
              <span className="flex items-center gap-1 text-sm text-success">
                <CheckCircle2 className="size-4" aria-hidden /> Saved as {saved.status} v{saved.version}
              </span>
            )}
            <Button onClick={() => generate.mutate()} loading={generate.isPending} disabled={!layout || stale}>
              <LayoutGrid /> Use this floor plan
            </Button>
          </div>
          {saved?.status === "draft" && (
            <Callout tone="warning" title="Saved as a draft">
              Products are already placed on your current floor plan, so the new plan was saved as draft v{saved.version} instead of replacing it. Move the
              planogram over and publish it from{" "}
              <Link to="/merchant/layout" className="font-medium text-primary underline-offset-4 hover:underline">
                Store layout
              </Link>
              .
            </Callout>
          )}
        </div>
      </div>
    </StepShell>
  );
}

function RangeControl({ id, label, hint, min, max, value, onChange }: { id: string; label: string; hint: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <output htmlFor={id} className="tabular text-sm font-semibold">
          {value}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-describedby={`${id}-hint`}
        className="w-full accent-primary"
      />
      <p id={`${id}-hint`} className="flex justify-between text-xs text-muted-foreground">
        <span>{hint}</span>
        <span className="tabular">
          {min}–{max}
        </span>
      </p>
    </div>
  );
}
