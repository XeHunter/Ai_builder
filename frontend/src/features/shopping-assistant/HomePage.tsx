import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Camera, ListChecks, MapPinned, MessageSquareText, Search, Sparkles, Tag, Users, X, type LucideIcon } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/data";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/input";
import { useShopperStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import type { ProductCard } from "@/types/api";

import { ProductGrid, ProductGridSkeleton, ProductTile } from "./components/ProductTile";
import { useCategories, useDebouncedValue, useStoreProducts } from "./hooks";

interface FeaturedPromotion {
  id: string;
  name: string;
  description: string | null;
  ends_at: string;
  promo_type: string;
  discount_value: number;
}

interface FeaturedResponse {
  promotions: FeaturedPromotion[];
  promoted_products: ProductCard[];
  markdowns: ProductCard[];
  best_sellers: ProductCard[];
}

const TILES: { to: string; label: string; description: string; icon: LucideIcon }[] = [
  { to: "/shop/assistant", label: "Ask the assistant", description: "Baskets, budgets and directions", icon: MessageSquareText },
  { to: "/shop/lists?new=1", label: "Smart list", description: "Type a list, we match products", icon: ListChecks },
  { to: "/shop/lists", label: "Shared lists", description: "Shop together in real time", icon: Users },
  { to: "/shop/navigate", label: "Store map", description: "Find the shortest route", icon: MapPinned },
  { to: "/shop/visual", label: "Photo search", description: "Find a product from a photo", icon: Camera },
];

const PAGE_SIZE = 20;

export default function HomePage() {
  const { store, storeId } = useShopperStore();
  const [query, setQuery] = React.useState("");
  const [submitted, setSubmitted] = React.useState<string | null>(null);
  const [category, setCategory] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const debounced = useDebouncedValue(query, 300);
  const q = (submitted ?? debounced).trim();
  const browsing = q.length > 0 || !!category;

  // Reset paging and filters when inputs or the store change.
  React.useEffect(() => {
    setPage(1);
  }, [q, category, storeId]);
  React.useEffect(() => {
    setCategory(null);
  }, [storeId]);

  const categories = useCategories(storeId);
  const results = useStoreProducts(storeId, { q, category_id: category, page, page_size: PAGE_SIZE }, browsing);
  const featured = useQuery({
    queryKey: ["store", storeId, "featured"],
    queryFn: () => api.get<FeaturedResponse>(`/stores/${storeId}/featured`),
    enabled: !!storeId,
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(query);
  };

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border bg-surface p-5 shadow-[var(--shadow-card)] sm:p-8" aria-labelledby="home-title">
        <p className="text-xs font-medium uppercase tracking-wide text-primary">{store ? `Shopping at ${store.name}` : "Choose a store"}</p>
        <h1 id="home-title" className="mt-1 text-2xl font-semibold sm:text-3xl">
          What are you shopping for today?
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Live prices, stock and shelf locations for this store.</p>
        <form role="search" onSubmit={onSubmit} className="mt-5 flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSubmitted(null);
              }}
              placeholder="Search milk, Tata tea, memory card…"
              aria-label="Search products"
              className="h-11 pl-9 text-base"
            />
          </div>
          <Button type="submit" size="lg">
            Search
          </Button>
        </form>

        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          {categories.isLoading &&
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-24 rounded-full" />)}
          {categories.data && (
            <CategoryChip active={!category} onClick={() => setCategory(null)}>
              All
            </CategoryChip>
          )}
          {categories.data?.map((c) => (
            <CategoryChip key={c.id} active={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}>
              {c.name} <span className="text-muted-foreground">{c.product_count}</span>
            </CategoryChip>
          ))}
        </div>
      </section>

      {browsing ? (
        <section aria-labelledby="results-title" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="results-title" className="text-lg font-semibold">
              {q ? `Results for “${q}”` : categories.data?.find((c) => c.id === category)?.name ?? "Products"}
              {results.data && <span className="ml-2 text-sm font-normal text-muted-foreground">{results.data.total} products</span>}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setSubmitted(null);
                setCategory(null);
              }}
            >
              <X aria-hidden /> Clear
            </Button>
          </div>
          {results.isLoading ? (
            <ProductGridSkeleton />
          ) : results.isError ? (
            <ErrorState error={results.error} onRetry={() => results.refetch()} />
          ) : !results.data?.items.length ? (
            <EmptyState
              icon={Search}
              title="No matching products"
              description="Try a different word, a brand name, or ask the assistant to suggest alternatives."
              action={
                <Button asChild variant="outline">
                  <Link to={`/shop/assistant`}>Ask the assistant</Link>
                </Button>
              }
            />
          ) : (
            <div className={cn(results.isFetching && "opacity-70 transition-opacity")}>
              <ProductGrid>
                {results.data.items.map((p) => (
                  <ProductTile key={p.id} product={p} />
                ))}
              </ProductGrid>
              {results.data.total > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={results.data.total} onPage={setPage} />}
            </div>
          )}
        </section>
      ) : (
        <>
          <QuickTiles />
          <Featured query={featured} />
        </>
      )}
    </div>
  );
}

function CategoryChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
        active ? "border-primary bg-primary-soft font-medium text-primary" : "border-border-strong bg-surface hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function QuickTiles() {
  return (
    <nav aria-label="Quick actions" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          className="group flex items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-[var(--shadow-card)] transition hover:border-primary/40"
        >
          <span className="rounded-md bg-primary-soft p-2 text-primary">
            <t.icon className="size-5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium group-hover:text-primary">{t.label}</span>
            <span className="block text-xs text-muted-foreground">{t.description}</span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

function Featured({ query }: { query: UseQueryResult<FeaturedResponse> }) {
  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <ProductGridSkeleton count={5} />
      </div>
    );
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const data = query.data;
  if (!data) return null;
  const empty = !data.promotions.length && !data.promoted_products.length && !data.markdowns.length && !data.best_sellers.length;
  if (empty) {
    return <EmptyState icon={Sparkles} title="Nothing featured right now" description="Search above or browse by category to find products." />;
  }
  return (
    <div className="space-y-8">
      {data.promotions.length > 0 && (
        <section aria-labelledby="promos-title" className="space-y-3">
          <SectionTitle id="promos-title" title="Offers this week" link={{ to: "/shop/offers", label: "All offers" }} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.promotions.map((p) => (
              <Link
                key={p.id}
                to="/shop/offers"
                className="flex items-start gap-3 rounded-lg border border-accent/20 bg-accent-soft p-4 transition hover:border-accent/50"
              >
                <Tag className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0">
                  <span className="block font-medium">{p.name}</span>
                  {p.description && <span className="block text-sm text-foreground/80">{p.description}</span>}
                  <span className="mt-1 block text-xs text-muted-foreground">Ends {formatDate(p.ends_at)}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <ProductSection id="promoted" title="On promotion" products={data.promoted_products} />
      <ProductSection
        id="markdowns"
        title="Short-dated markdowns"
        hint={<Badge variant="warning">Best before soon</Badge>}
        products={data.markdowns}
      />
      <ProductSection id="best" title="Best sellers at this store" products={data.best_sellers} />
    </div>
  );
}

function SectionTitle({ id, title, hint, link }: { id: string; title: string; hint?: React.ReactNode; link?: { to: string; label: string } }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 id={id} className="flex items-center gap-2 text-lg font-semibold">
        {title} {hint}
      </h2>
      {link && (
        <Link to={link.to} className="text-sm font-medium text-primary hover:underline">
          {link.label}
        </Link>
      )}
    </div>
  );
}

function ProductSection({ id, title, hint, products }: { id: string; title: string; hint?: React.ReactNode; products: ProductCard[] }) {
  if (!products.length) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <SectionTitle id={`${id}-title`} title={title} hint={hint} />
      <ProductGrid>
        {products.map((p) => (
          <ProductTile key={p.id} product={p} />
        ))}
      </ProductGrid>
    </section>
  );
}
