import { Check, Minus, MoreHorizontal, Plus, Replace, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { cn, formatCurrency, formatNumber, timeAgo } from "@/lib/utils";
import type { ListItem } from "@/types/api";
import { effectivePrice } from "@/features/shopping-assistant/components/product-meta";

export const REVIEW_THRESHOLD = 0.75;

export function itemNeedsReview(item: ListItem): boolean {
  return item.status === "unresolved" || (item.match_confidence !== null && item.match_confidence < REVIEW_THRESHOLD);
}

interface Props {
  item: ListItem;
  canEdit: boolean;
  collectedByName?: string | null;
  onToggle: () => void;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
  onChangeMatch: () => void;
}

export function ListItemRow({ item, canEdit, collectedByName, onToggle, onQuantity, onRemove, onChangeMatch }: Props) {
  const collected = item.status === "collected";
  const unresolved = item.status === "unresolved";
  const review = itemNeedsReview(item);
  const p = item.product;
  const name = p?.name ?? item.display_name;
  const canToggle = canEdit && !unresolved;

  return (
    <li className={cn("flex items-start gap-3 px-3 py-3 sm:px-4", collected && "bg-muted/40")}>
      <button
        type="button"
        role="checkbox"
        aria-checked={collected}
        aria-label={collected ? `Mark ${name} as not collected` : `Mark ${name} as collected`}
        disabled={!canToggle}
        onClick={onToggle}
        title={unresolved ? "Choose a product before checking this item off" : undefined}
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          collected ? "border-success bg-success text-white" : "border-border-strong bg-surface hover:border-primary",
        )}
      >
        {collected && <Check className="size-4" aria-hidden />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {p ? (
            <Link to={`/shop/products/${p.id}`} className={cn("font-medium hover:text-primary hover:underline", collected && "text-muted-foreground line-through")}>
              {name}
            </Link>
          ) : (
            <span className={cn("font-medium", collected && "text-muted-foreground line-through")}>{name}</span>
          )}
          {unresolved && <Badge variant="danger">No match yet</Badge>}
          {item.status === "unavailable" && <Badge variant="warning">Out of stock here</Badge>}
          {!unresolved && review && <Badge variant="warning">Check match</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {item.raw_text && item.raw_text.toLowerCase() !== name.toLowerCase() && <span>You wrote “{item.raw_text}”</span>}
          {p?.location && (
            <span>
              {p.location.aisle_label} · <span className="font-mono">{p.location.shelf_code}</span>
            </span>
          )}
          {p && (
            <span className="tabular">
              {formatCurrency(effectivePrice(p))}
              {item.quantity !== 1 && ` × ${formatNumber(item.quantity, 2)}`}
            </span>
          )}
          {collected && (
            <span>
              Collected{collectedByName ? ` by ${collectedByName}` : ""} {item.collected_at ? timeAgo(item.collected_at) : ""}
            </span>
          )}
        </div>
        {unresolved && canEdit && (
          <Button size="sm" variant="outline" className="mt-2" onClick={onChangeMatch}>
            <Replace aria-hidden /> Choose a product
          </Button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {canEdit ? (
          <div className="flex items-center rounded-md border border-border" role="group" aria-label={`Quantity of ${name}`}>
            <button
              type="button"
              className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() => onQuantity(Math.max(1, item.quantity - 1))}
              disabled={item.quantity <= 1}
              aria-label={`Decrease quantity of ${name}`}
            >
              <Minus className="size-3.5" />
            </button>
            <span className="tabular min-w-7 text-center text-sm" aria-live="polite">
              {formatNumber(item.quantity, 2)}
              {item.unit ? <span className="ml-0.5 text-xs text-muted-foreground">{item.unit}</span> : null}
            </span>
            <button
              type="button"
              className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
              onClick={() => onQuantity(item.quantity + 1)}
              disabled={item.quantity >= 1000}
              aria-label={`Increase quantity of ${name}`}
            >
              <Plus className="size-3.5" />
            </button>
          </div>
        ) : (
          <span className="tabular text-sm text-muted-foreground">
            × {formatNumber(item.quantity, 2)} {item.unit ?? ""}
          </span>
        )}
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`More actions for ${name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onChangeMatch}>
                <Replace /> Change product
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onRemove} className="text-danger">
                <Trash2 /> Remove from list
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}
