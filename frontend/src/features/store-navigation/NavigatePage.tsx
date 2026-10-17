import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Accessibility, ListChecks, MapPin, MapPinned, Plus, RotateCcw, Search, X } from "lucide-react";
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { StoreMap } from "@/components/maps/StoreMap";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState, Skeleton, Spinner } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/menu";
import { useShopperStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import type { ProductCard, RouteResponse, ShoppingListView } from "@/types/api";
import { useMyLists } from "@/features/shopping-assistant/components/AddToListButton";
import { effectivePrice } from "@/features/shopping-assistant/components/product-meta";
import { useDebouncedValue, useStoreProducts } from "@/features/shopping-assistant/hooks";

import { RouteSteps, RouteSummary, UnroutedList } from "./components/RouteDetails";
import { useFloorplan } from "./use-floorplan";

interface Destination {
  id: string;
  name: string;
  shelf: string | null;
}

const MAX_DESTINATIONS = 40;

function toDestination(p: ProductCard): Destination {
  return { id: p.id, name: p.name, shelf: p.location?.shelf_code ?? null };
}

export default function NavigatePage() {
  const { store, storeId } = useShopperStore();
  const [params, setParams] = useSearchParams();
  const [destinations, setDestinations] = React.useState<Destination[]>([]);
  const [start, setStart] = React.useState<{ x: number; y: number } | null>(null);
  const [accessible, setAccessible] = React.useState(false);
  const floor = useFloorplan(storeId);

  // A new store has a different floor plan and catalog.
  const prevStore = React.useRef(storeId);
  React.useEffect(() => {
    if (prevStore.current && prevStore.current !== storeId) {
      setDestinations([]);
      setStart(null);
    }
    prevStore.current = storeId;
  }, [storeId]);

  const add = React.useCallback((items: Destination[]) => {
    setDestinations((cur) => {
      const ids = new Set(cur.map((d) => d.id));
      const merged = [...cur, ...items.filter((d) => !ids.has(d.id))];
      if (merged.length > MAX_DESTINATIONS) toast.warning(`Routes can include up to ${MAX_DESTINATIONS} products.`);
      return merged.slice(0, MAX_DESTINATIONS);
    });
  }, []);

  // ?product=<id> (e.g. from a product page) preloads a destination.
  const preload = params.get("product");
  React.useEffect(() => {
    if (!preload || !storeId) return;
    let cancelled = false;
    api
      .get<{ product: ProductCard }>(`/stores/${storeId}/products/${preload}`)
      .then((d) => !cancelled && add([toDestination(d.product)]))
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => {
        if (cancelled) return;
        const next = new URLSearchParams(params);
        next.delete("product");
        setParams(next, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [preload, storeId, add, params, setParams]);

  const ids = destinations.map((d) => d.id);
  const route = useQuery({
    queryKey: ["store", storeId, "route", ids, start?.x ?? null, start?.y ?? null, accessible],
    queryFn: () =>
      api.post<RouteResponse>(`/stores/${storeId}/route`, { product_ids: ids, start_x: start?.x, start_y: start?.y, accessible_only: accessible }),
    enabled: !!storeId && ids.length > 0,
    placeholderData: keepPreviousData,
  });
  const routeData = ids.length ? route.data : undefined;
  const highlight = destinations.map((d) => d.shelf).filter((s): s is string => !!s);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={store?.name} title="Store map" description="Add the products you want and we'll plan the shortest walk through the store." />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Destinations</CardTitle>
              <CardDescription>Search for products, or load them from one of your lists.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ProductSearch storeId={storeId} onAdd={(p) => add([toDestination(p)])} selected={new Set(ids)} />
              <ListLoader storeId={store?.id ?? null} onLoad={add} />
              {destinations.length > 0 ? (
                <div>
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium">{destinations.length} selected</span>
                    <Button size="sm" variant="ghost" onClick={() => setDestinations([])}>
                      Clear all
                    </Button>
                  </div>
                  <ul className="flex flex-wrap gap-2" aria-label="Selected destinations">
                    {destinations.map((d) => (
                      <li key={d.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary-soft py-1 pl-3 pr-1 text-xs text-primary">
                        <span className="truncate">{d.name}</span>
                        <button
                          type="button"
                          onClick={() => setDestinations((cur) => cur.filter((x) => x.id !== d.id))}
                          className="rounded-full p-0.5 hover:bg-primary/10"
                          aria-label={`Remove ${d.name}`}
                        >
                          <X className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-5">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={accessible} onCheckedChange={setAccessible} aria-label="Step-free routes only" />
                <Accessibility className="size-4 text-muted-foreground" aria-hidden /> Step-free routes only (avoid narrow or stepped paths)
              </label>
              <Callout title="Where are you?">
                Indoor positioning isn't available, so we start at the entrance. Tap anywhere on the floor plan to set your current spot manually.
              </Callout>
              {start && (
                <Button size="sm" variant="outline" onClick={() => setStart(null)}>
                  <RotateCcw aria-hidden /> Start from the entrance
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {floor.isLoading ? (
            <Skeleton className="aspect-[4/3] w-full" />
          ) : floor.isError ? (
            <ErrorState error={floor.error} onRetry={() => floor.refetch()} />
          ) : floor.data ? (
            <StoreMap
              layout={floor.data}
              route={routeData}
              highlight={highlight}
              start={start}
              onFloorClick={(pt) => setStart({ x: Math.max(0, Math.round(pt.x * 10) / 10), y: Math.max(0, Math.round(pt.y * 10) / 10) })}
              ariaLabel={`Floor plan of ${store?.name ?? "the store"}. Click the floor to set your start point.`}
            />
          ) : null}

          {destinations.length === 0 ? (
            <EmptyState icon={MapPinned} title="No destinations yet" description="Add products on the left to see the shortest route through the store." />
          ) : route.isError ? (
            <ErrorState error={route.error} onRetry={() => route.refetch()} />
          ) : routeData ? (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <CardTitle>Your route</CardTitle>
                {route.isFetching && <Spinner label="Updating" />}
              </CardHeader>
              <CardContent className="space-y-4">
                <RouteSummary route={routeData} />
                <UnroutedList route={routeData} />
                <RouteSteps route={routeData} />
              </CardContent>
            </Card>
          ) : (
            <Spinner label="Planning your route" />
          )}
        </div>
      </div>
    </div>
  );
}

function ProductSearch({ storeId, onAdd, selected }: { storeId: string | null; onAdd: (p: ProductCard) => void; selected: Set<string> }) {
  const [q, setQ] = React.useState("");
  const debounced = useDebouncedValue(q, 250);
  const results = useStoreProducts(storeId, { q: debounced, page_size: 6 }, debounced.trim().length > 1);
  const show = debounced.trim().length > 1;
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products to add" aria-label="Search products to add" className="pl-9" />
      </div>
      {show && (
        <div className="mt-2 rounded-md border border-border">
          {results.isLoading ? (
            <Spinner label="Searching" className="p-3" />
          ) : results.isError ? (
            <p className="p-3 text-sm text-danger">{errorMessage(results.error)}</p>
          ) : !results.data?.items.length ? (
            <p className="p-3 text-sm text-muted-foreground">No products match “{debounced}”.</p>
          ) : (
            <ul className="divide-y divide-border" aria-label="Search results">
              {results.data.items.map((p) => {
                const already = selected.has(p.id);
                return (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="size-3" aria-hidden />
                        {p.location ? `${p.location.aisle_label} · ${p.location.shelf_code}` : "Location not mapped"} · {formatCurrency(effectivePrice(p))}
                      </span>
                    </span>
                    <Button size="sm" variant={already ? "ghost" : "outline"} disabled={already} onClick={() => onAdd(p)} aria-label={`Add ${p.name} to route`}>
                      {already ? "Added" : <Plus aria-hidden />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ListLoader({ storeId, onLoad }: { storeId: string | null; onLoad: (d: Destination[]) => void }) {
  const lists = useMyLists();
  const [listId, setListId] = React.useState("");
  const options = (lists.data ?? []).filter((l) => l.store_id === storeId && l.status !== "archived");
  const load = useMutation({
    mutationFn: (id: string) => api.get<ShoppingListView>(`/shopping-lists/${id}`),
    onSuccess: (list) => {
      const items = list.items
        .filter((i) => i.product && i.status !== "collected")
        .map((i) => ({ id: i.product!.id, name: i.product!.name, shelf: i.product!.location?.shelf_code ?? null }));
      if (!items.length) toast.info("That list has no remaining items with a product match.");
      else {
        onLoad(items);
        toast.success(`Added ${items.length} item${items.length === 1 ? "" : "s"} from “${list.name}”`);
      }
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!lists.isLoading && !options.length) return null;
  return (
    <div className="flex items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium">
        <span className="flex items-center gap-1.5">
          <ListChecks className="size-4 text-muted-foreground" aria-hidden /> Use my shopping list
        </span>
        <Select value={listId} onChange={(e) => setListId(e.target.value)} disabled={lists.isLoading}>
          <option value="">{lists.isLoading ? "Loading lists…" : "Choose a list"}</option>
          {options.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.item_count - l.collected_count} left)
            </option>
          ))}
        </Select>
      </label>
      <Button variant="outline" disabled={!listId} loading={load.isPending} onClick={() => load.mutate(listId)}>
        Load
      </Button>
    </div>
  );
}
