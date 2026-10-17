/** Reusable product card used on the home page, product page, assistant and visual search results. */
import type * as React from "react";
import { Link } from "react-router-dom";

import { cn } from "@/lib/utils";
import type { ProductCard } from "@/types/api";

import { AddToListButton } from "./AddToListButton";
import { LocationText, PriceTag, ProductImage, StockBadge } from "./product-meta";

interface ProductTileProps {
  product: ProductCard;
  /** Extra line shown under the name, e.g. a complementary-product reason. */
  note?: React.ReactNode;
  /** Badges rendered over the image (e.g. similarity %). */
  badge?: React.ReactNode;
  /** Additional content above the actions (e.g. basket quantity / line total). */
  extra?: React.ReactNode;
  compact?: boolean;
  showAddToList?: boolean;
  className?: string;
}

export function ProductTile({ product, note, badge, extra, compact, showAddToList = true, className }: ProductTileProps) {
  const href = `/shop/products/${product.id}`;
  return (
    <article
      className={cn("flex flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-[var(--shadow-card)]", className)}
      aria-label={product.name}
    >
      <Link to={href} className="relative block" tabIndex={-1} aria-hidden>
        <ProductImage product={product} className={compact ? "aspect-[4/3]" : "aspect-square"} />
        {badge && <div className="absolute left-2 top-2 flex flex-wrap gap-1">{badge}</div>}
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          {product.brand && <p className="truncate text-xs text-muted-foreground">{product.brand}</p>}
          <Link to={href} className="line-clamp-2 text-sm font-medium leading-snug hover:text-primary hover:underline">
            {product.name}
          </Link>
          <p className="text-xs text-muted-foreground">{product.unit}</p>
        </div>
        {note && <p className="rounded-md bg-primary-soft px-2 py-1 text-xs text-primary">{note}</p>}
        <PriceTag product={product} size="sm" />
        <div className="flex flex-wrap items-center gap-2">
          <StockBadge level={product.stock_level} />
        </div>
        <LocationText location={product.location} />
        {extra}
        {showAddToList && (
          <div className="mt-auto pt-1">
            <AddToListButton productId={product.id} productName={product.name} className="w-full" />
          </div>
        )}
      </div>
    </article>
  );
}

export function ProductGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5", className)}>{children}</div>;
}

export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <ProductGrid>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface" aria-hidden>
          <div className="aspect-square animate-pulse bg-muted" />
          <div className="space-y-2 p-3">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </ProductGrid>
  );
}
