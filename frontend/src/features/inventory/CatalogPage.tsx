import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Search } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, Pagination } from "@/components/ui/data";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { JobStatus, useDebouncedValue } from "@/features/merchant-dashboard/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn, formatCurrency, formatNumber, formatPct } from "@/lib/utils";
import type { Page } from "@/types/api";

import { ProductFormDialog } from "./components/ProductFormDialog";
import type { AdminProduct, MerchantCategory } from "./types";

const PAGE_SIZE = 25;

export default function CatalogPage() {
  const { can } = useAuth();
  const canWrite = can("catalog.write");
  const qc = useQueryClient();
  const [search, setSearch] = React.useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [categoryId, setCategoryId] = React.useState("");
  const [status, setStatus] = React.useState("active");
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminProduct | null>(null);
  const [jobId, setJobId] = React.useState<string | null>(null);

  React.useEffect(() => setPage(1), [q, categoryId, status]);

  const cats = useQuery({ queryKey: ["merchant", "catalog", "categories"], queryFn: () => api.get<MerchantCategory[]>("/merchant/categories"), staleTime: 5 * 60_000 });
  const list = useQuery({
    queryKey: ["merchant", "catalog", "products", q, categoryId, status, page],
    queryFn: () => api.get<Page<AdminProduct>>("/merchant/products", { q, category_id: categoryId, status, page, page_size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const reindex = useMutation({
    mutationFn: () => api.post<{ job_id: string; status: string }>("/merchant/products/reindex"),
    onSuccess: (r) => {
      setJobId(r.job_id);
      toast.success("Search index rebuild queued");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const onJobDone = React.useCallback(
    (job: { status: string }) => {
      if (job.status === "succeeded") toast.success("Search index rebuilt");
      else toast.error("Search index rebuild failed");
      void qc.invalidateQueries({ queryKey: ["merchant", "jobs"] });
    },
    [qc],
  );

  return (
    <div>
      <PageHeader
        eyebrow="Catalog"
        title="Product catalog"
        description="Master product data shared by all stores. Stock levels live in Inventory; selling-price changes go through Pricing approvals."
        actions={
          canWrite && (
            <>
              <Button variant="outline" onClick={() => reindex.mutate()} loading={reindex.isPending}>
                <RefreshCw /> Rebuild search index
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus /> New product
              </Button>
            </>
          )
        }
      />
      {jobId && <JobStatus jobId={jobId} label="Search index rebuild" onDone={onJobDone} className="mb-4" />}

      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input aria-label="Search products" placeholder="Search by name, SKU or brand" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
          </div>
          <Select aria-label="Filter by category" className="sm:w-56" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by status" className="sm:w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="">All statuses</option>
          </Select>
        </div>

        {list.isLoading ? (
          <SkeletonRows rows={8} className="p-3" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} className="m-3" />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState
            className="m-3"
            title="No products found"
            description={q || categoryId ? "Try a different search or category." : "Create your first product or import inventory."}
            action={canWrite && !q ? <Button onClick={() => setCreating(true)}>New product</Button> : undefined}
          />
        ) : (
          <>
            <Table className={cn(list.isPlaceholderData && "opacity-60")}>
              <THead>
                <TR>
                  <TH>SKU</TH>
                  <TH>Product</TH>
                  <TH>Category</TH>
                  <TH className="text-right">Price</TH>
                  <TH className="text-right">Cost</TH>
                  <TH className="text-right">Margin</TH>
                  <TH className="text-right">Min price</TH>
                  <TH className="text-right">Stock</TH>
                  <TH>Status</TH>
                  <TH>Flags</TH>
                  {canWrite && <TH className="sr-only">Actions</TH>}
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-mono text-xs">{p.sku}</TD>
                    <TD>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[p.brand, p.unit].filter(Boolean).join(" · ")}
                      </div>
                    </TD>
                    <TD className="text-muted-foreground">{p.category_name ?? "—"}</TD>
                    <TD className="tabular text-right">{formatCurrency(p.price)}</TD>
                    <TD className="tabular text-right text-muted-foreground">{formatCurrency(p.cost_price)}</TD>
                    <TD className={cn("tabular text-right", p.margin_pct !== null && p.margin_pct < 10 && "text-warning")}>{formatPct(p.margin_pct, 1)}</TD>
                    <TD className="tabular text-right text-muted-foreground">{formatCurrency(p.min_allowed_price)}</TD>
                    <TD className={cn("tabular text-right", (p.total_stock ?? 0) === 0 && "text-danger")}>{formatNumber(p.total_stock)}</TD>
                    <TD>
                      <StatusBadge status={p.status} />
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {p.is_perishable && <Badge variant="warning">Perishable</Badge>}
                        {p.is_child_product && <Badge variant="info">Child</Badge>}
                        {p.promotion_eligible ? <Badge variant="success">Promo-eligible</Badge> : <Badge>No promos</Badge>}
                      </div>
                    </TD>
                    {canWrite && (
                      <TD className="text-right">
                        <Button variant="ghost" size="icon" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                          <Pencil />
                        </Button>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="border-t border-border px-3">
              <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
            </div>
          </>
        )}
      </Card>

      <ProductFormDialog open={creating} onOpenChange={setCreating} categories={cats.data ?? []} />
      <ProductFormDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} categories={cats.data ?? []} product={editing} />
    </div>
  );
}
