/** Small presentational helpers for product price, stock and shelf location. */
import { MapPin } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency } from "@/lib/utils";
import type { ProductCard } from "@/types/api";

/** The price a shopper actually pays today (markdown beats promotion beats list price). */
export function effectivePrice(p: Pick<ProductCard, "price" | "promotion" | "markdown">): number {
  const candidates = [p.price];
  if (p.promotion) candidates.push(p.promotion.price);
  if (p.markdown) candidates.push(p.markdown.price);
  return Math.min(...candidates);
}

export function PriceTag({ product, size = "md", className }: { product: ProductCard; size?: "sm" | "md" | "lg"; className?: string }) {
  const now = effectivePrice(product);
  const discounted = now < product.price;
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", className)}>
      <span className={cn("tabular font-semibold", size === "lg" ? "text-2xl" : size === "sm" ? "text-sm" : "text-base", discounted && "text-primary")}>
        {formatCurrency(now)}
      </span>
      {discounted && (
        <span className="tabular text-xs text-muted-foreground line-through" aria-label={`Regular price ${formatCurrency(product.price)}`}>
          {formatCurrency(product.price)}
        </span>
      )}
      {product.markdown && now === product.markdown.price ? (
        <Badge variant="warning">Short-dated{product.markdown.pct ? ` −${Math.round(product.markdown.pct)}%` : ""}</Badge>
      ) : product.promotion && now === product.promotion.price ? (
        <Badge variant="accent">Offer</Badge>
      ) : null}
    </div>
  );
}

const STOCK_LABEL: Record<ProductCard["stock_level"], string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
};

export function StockBadge({ level }: { level: ProductCard["stock_level"] }) {
  const variant = level === "in_stock" ? "success" : level === "low_stock" ? "warning" : "danger";
  return <Badge variant={variant}>{STOCK_LABEL[level]}</Badge>;
}

export function LocationText({ location, className }: { location: ProductCard["location"]; className?: string }) {
  if (!location) return <span className={cn("text-xs text-muted-foreground", className)}>Location not mapped</span>;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <MapPin className="size-3.5 shrink-0" aria-hidden />
      <span>
        {location.aisle_label} · <span className="font-mono">{location.shelf_code}</span> · level {location.level}
      </span>
    </span>
  );
}

/** Image with a graceful placeholder (product images are served from /media by the API). */
export function ProductImage({ product, className }: { product: Pick<ProductCard, "image_url" | "name">; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center overflow-hidden bg-muted", className)}>
      {product.image_url ? (
        <img src={product.image_url} alt={product.name} loading="lazy" className="h-full w-full object-contain" />
      ) : (
        <span className="px-2 text-center text-xs text-muted-foreground">No image</span>
      )}
    </div>
  );
}
