import { ArrowLeft, MapPinned, MessageSquareText, PackageSearch } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import { StoreMap } from "@/components/maps/StoreMap";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KeyValue } from "@/components/ui/data";
import { Callout, EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { useShopperStore } from "@/hooks/use-stores";
import { ApiError } from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useFloorplan } from "@/features/store-navigation/use-floorplan";

import { AddToListButton } from "./components/AddToListButton";
import { LocationText, PriceTag, ProductImage, StockBadge } from "./components/product-meta";
import { ProductGrid, ProductTile } from "./components/ProductTile";
import { useProductDetail } from "./hooks";

export default function ProductPage() {
  const { productId } = useParams();
  const { store, storeId } = useShopperStore();
  const detail = useProductDetail(storeId, productId);
  const floor = useFloorplan(storeId);

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
      <Link to="/shop">
        <ArrowLeft aria-hidden /> Back to shopping
      </Link>
    </Button>
  );

  if (detail.isLoading || !storeId) {
    return (
      <div>
        {back}
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="aspect-square w-full" />
          <div className="space-y-3">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    );
  }
  if (detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div>
        {back}
        {notFound ? (
          <EmptyState icon={PackageSearch} title="Product not found" description={`This product is not sold at ${store?.name ?? "the selected store"}.`} />
        ) : (
          <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
        )}
      </div>
    );
  }
  const data = detail.data!;
  const p = data.product;

  return (
    <div className="space-y-8">
      <div>
        {back}
        <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ProductImage product={p} className="aspect-square w-full rounded-lg border border-border" />
          <div className="space-y-4">
            <div>
              {p.category && <p className="text-xs font-medium uppercase tracking-wide text-primary">{p.category.name}</p>}
              <h1 className="mt-1 text-2xl font-semibold">{p.name}</h1>
              <p className="text-sm text-muted-foreground">
                {[p.brand, p.unit, `SKU ${p.sku}`].filter(Boolean).join(" · ")}
              </p>
            </div>
            <PriceTag product={p} size="lg" />
            <div className="flex flex-wrap items-center gap-2">
              <StockBadge level={p.stock_level} />
              {p.is_perishable && <Badge variant="info">Perishable</Badge>}
              {p.tags.slice(0, 5).map((t) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
            </div>
            {p.description && <p className="text-sm leading-relaxed text-foreground/85">{p.description}</p>}

            {p.promotion && (
              <Callout title={`Offer: ${p.promotion.name}`}>
                {formatCurrency(p.promotion.price)} until {formatDate(p.promotion.ends_at)}.
              </Callout>
            )}
            {p.markdown && (
              <Callout tone="warning" title="Short-dated markdown">
                {p.markdown.quantity} unit{p.markdown.quantity === 1 ? "" : "s"} at {formatCurrency(p.markdown.price)}
                {p.markdown.expiry_date ? `, best before ${formatDate(p.markdown.expiry_date)}` : ""} (batch {p.markdown.batch_code}).
              </Callout>
            )}

            <div className="flex flex-wrap gap-2">
              <AddToListButton productId={p.id} productName={p.name} size="md" variant="default" />
              <Button asChild variant="outline">
                <Link to={`/shop/assistant?product=${p.id}`}>
                  <MessageSquareText aria-hidden /> Ask the assistant about this
                </Link>
              </Button>
              {p.location && (
                <Button asChild variant="ghost">
                  <Link to={`/shop/navigate?product=${p.id}`}>
                    <MapPinned aria-hidden /> Route me there
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Where to find it</CardTitle>
          <CardDescription>
            <LocationText location={p.location} className="text-sm" />
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          {floor.isLoading ? (
            <Skeleton className="aspect-[4/3] w-full" />
          ) : floor.isError ? (
            <ErrorState error={floor.error} onRetry={() => floor.refetch()} />
          ) : floor.data ? (
            <StoreMap
              layout={floor.data}
              highlight={p.location ? [p.location.shelf_code] : []}
              selectedShelfCode={p.location?.shelf_code}
              ariaLabel={`Floor plan of ${store?.name ?? "the store"} highlighting ${p.name}`}
            />
          ) : null}
          {p.location ? (
            <KeyValue
              items={[
                ["Aisle", p.location.aisle_label],
                ["Fixture", p.location.fixture_label],
                ["Shelf", <span className="font-mono">{p.location.shelf_code}</span>],
                ["Level", `${p.location.level} (from the floor)`],
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">This product has no mapped shelf location at this store. Ask a store associate.</p>
          )}
        </CardContent>
      </Card>

      {data.complementary.length > 0 && (
        <section aria-labelledby="goes-with" className="space-y-3">
          <h2 id="goes-with" className="text-lg font-semibold">
            Goes well with
          </h2>
          <ProductGrid>
            {data.complementary.map((c) => (
              <ProductTile key={c.id} product={c} note={data.complement_reasons[c.id] ?? c.reason ?? undefined} />
            ))}
          </ProductGrid>
        </section>
      )}
    </div>
  );
}
