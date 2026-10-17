/** Optimised in-store route for a list; recalculates when items change or the start point moves. */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Accessibility, MapPinned, RotateCcw } from "lucide-react";
import * as React from "react";

import { StoreMap } from "@/components/maps/StoreMap";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui/feedback";
import { Switch } from "@/components/ui/menu";
import { api } from "@/lib/api";
import type { ListItem, RouteResponse } from "@/types/api";
import { useDebouncedValue } from "@/features/shopping-assistant/hooks";
import { RouteSteps, RouteSummary, UnroutedList } from "@/features/store-navigation/components/RouteDetails";
import { useFloorplan } from "@/features/store-navigation/use-floorplan";

interface Props {
  listId: string;
  storeId: string | null;
  items: ListItem[];
}

export function RoutePanel({ listId, storeId, items }: Props) {
  const [enabled, setEnabled] = React.useState(false);
  const [start, setStart] = React.useState<{ x: number; y: number } | null>(null);
  const [accessible, setAccessible] = React.useState(false);
  const floor = useFloorplan(enabled ? storeId : null);

  // Recalculate only when the routable set changes (not on check-off, so completed stops stay visible).
  const itemsKey = React.useMemo(
    () =>
      items
        .filter((i) => i.product_id)
        .map((i) => `${i.id}:${i.product_id}:${i.status === "unavailable" ? 1 : 0}`)
        .sort()
        .join("|"),
    [items],
  );
  const debouncedKey = useDebouncedValue(itemsKey, 700);

  const route = useQuery({
    queryKey: ["list-route", listId, debouncedKey, start?.x ?? null, start?.y ?? null, accessible],
    queryFn: () =>
      api.post<RouteResponse>(`/shopping-lists/${listId}/route`, {
        start_x: start?.x,
        start_y: start?.y,
        accessible_only: accessible,
        include_collected: true,
      }),
    enabled: enabled && !!storeId,
    placeholderData: keepPreviousData,
  });

  const collected = React.useMemo(() => new Set(items.filter((i) => i.status === "collected").map((i) => i.id)), [items]);
  const completedStops = React.useMemo(
    () => (route.data?.stops ?? []).filter((s) => s.items.length && s.items.every((i) => collected.has(i.item_id))).map((s) => s.order),
    [route.data, collected],
  );
  const highlight = React.useMemo(
    () => (route.data?.stops ?? []).flatMap((s) => s.items.map((i) => i.shelf_code)).filter((c): c is string => !!c),
    [route.data],
  );

  if (!storeId) {
    return (
      <Card>
        <CardContent className="pt-5">
          <EmptyState icon={MapPinned} title="No store selected for this list" description="Routes need a store floor plan." />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Shortest route</CardTitle>
          <CardDescription>
            {enabled ? "Tap the floor plan to set where you are. Indoor positioning isn't available, so start defaults to the entrance." : "Visit every aisle once, in the best order."}
          </CardDescription>
        </div>
        {enabled && route.isFetching && <Spinner label="Updating" />}
      </CardHeader>
      <CardContent className="space-y-4">
        {!enabled ? (
          <Button onClick={() => setEnabled(true)} className="w-full">
            <MapPinned aria-hidden /> Plan my route
          </Button>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={accessible} onCheckedChange={setAccessible} aria-label="Step-free routes only" />
                <Accessibility className="size-4 text-muted-foreground" aria-hidden /> Step-free only
              </label>
              {start && (
                <Button size="sm" variant="ghost" onClick={() => setStart(null)}>
                  <RotateCcw aria-hidden /> Start from entrance
                </Button>
              )}
            </div>
            {floor.isLoading ? (
              <Skeleton className="aspect-[4/3] w-full" />
            ) : floor.isError ? (
              <ErrorState error={floor.error} onRetry={() => floor.refetch()} />
            ) : floor.data ? (
              <StoreMap
                layout={floor.data}
                route={route.data}
                highlight={highlight}
                start={start}
                onFloorClick={(pt) => setStart({ x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 })}
                completedStops={completedStops}
                ariaLabel="Store floor plan with your route. Click the floor to set your start point."
              />
            ) : null}
            {route.isError ? (
              <ErrorState error={route.error} onRetry={() => route.refetch()} />
            ) : route.data ? (
              <>
                <RouteSummary route={route.data} />
                {route.data.stops.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {completedStops.length} of {route.data.stops.length} stops done
                  </p>
                )}
                <UnroutedList route={route.data} />
                {route.data.stops.length ? (
                  <RouteSteps route={route.data} doneKeys={collected} />
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing to route yet — add items with a product match.</p>
                )}
              </>
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
