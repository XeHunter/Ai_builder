import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { FileUp, Search } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";

import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader, Pagination } from "@/components/ui/data";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth } from "@/features/auth/auth-context";
import { useDebouncedValue } from "@/features/merchant-dashboard/components/common";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";
import { cn, formatCurrency, formatDate, formatNumber } from "@/lib/utils";
import type { Page } from "@/types/api";

import { InventoryDrawer } from "./components/InventoryDrawer";
import type { InventoryRow, MerchantCategory } from "./types";

const PAGE_SIZE = 25;

export default function InventoryPage() {
  const { storeId } = useMerchantStore();
  const { can } = useAuth();
  const [search, setSearch] = React.useState("");
  const q = useDebouncedValue(search.trim(), 300);
  const [categoryId, setCategoryId] = React.useState("");
  const [stockStatus, setStockStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => setPage(1), [q, categoryId, stockStatus, storeId]);

  const cats = useQuery({
    queryKey: ["merchant", "catalog", "categories"],
    queryFn: () => api.get<MerchantCategory[]>("/merchant/categories"),
    staleTime: 5 * 60_000,
    enabled: can("catalog.read"),
  });
  const list = useQuery({
    queryKey: ["merchant", "inventory", "list", storeId, q, categoryId, stockStatus, page],
    queryFn: () =>
      api.get<Page<InventoryRow>>("/merchant/inventory", { store_id: storeId, q, category_id: categoryId, stock_status: stockStatus, page, page_size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Stock levels"
        description="On-hand stock per store, with batches, expiry and shelf placement. Select a row to receive, count or write off stock."
        actions={
          can("inventory.import") && (
            <Button asChild variant="outline">
              <Link to="/merchant/inventory/import">
                <FileUp /> Import inventory
              </Link>
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input aria-label="Search inventory" placeholder="Search by product name or SKU" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
          </div>
          <Select aria-label="Filter by category" className="sm:w-56" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by stock status" className="sm:w-44" value={stockStatus} onChange={(e) => setStockStatus(e.target.value)}>
            <option value="">Any stock status</option>
            <option value="in_stock">In stock</option>
            <option value="low_stock">Low stock</option>
            <option value="out_of_stock">Out of stock</option>
          </Select>
        </div>
        {list.isLoading ? (
          <SkeletonRows rows={8} className="p-3" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} className="m-3" />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState className="m-3" title="No inventory matches" description="Change the filters, or import inventory from a CSV/XLSX file." />
        ) : (
          <>
            <Table className={cn(list.isPlaceholderData && "opacity-60")}>
              <THead>
                <TR>
                  <TH>Product</TH>
                  <TH>Store</TH>
                  <TH>Category</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Reorder at</TH>
                  <TH>Status</TH>
                  <TH>Shelf</TH>
                  <TH>Next expiry</TH>
                  <TH className="text-right">Batches</TH>
                  <TH className="text-right">Price</TH>
                </TR>
              </THead>
              <TBody>
                {list.data.items.map((r) => (
                  <TR
                    key={r.id}
                    tabIndex={0}
                    className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
                    data-selected={openId === r.id}
                    onClick={() => setOpenId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenId(r.id);
                      }
                    }}
                    aria-label={`Open ${r.name} at ${r.store_code}`}
                  >
                    <TD>
                      <div className="font-medium">{r.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.sku}</div>
                    </TD>
                    <TD>
                      <Badge variant="outline">{r.store_code}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">{r.category ?? "—"}</TD>
                    <TD className="tabular text-right font-medium">{formatNumber(r.quantity_on_hand)}</TD>
                    <TD className="tabular text-right text-muted-foreground">{r.reorder_point}</TD>
                    <TD>
                      <StatusBadge status={r.stock_status} />
                    </TD>
                    <TD className="font-mono text-xs">{r.shelf_code ?? <span className="text-muted-foreground">unplaced</span>}</TD>
                    <TD className="whitespace-nowrap">{r.next_expiry ? formatDate(r.next_expiry) : <span className="text-muted-foreground">—</span>}</TD>
                    <TD className="tabular text-right">{r.batch_count}</TD>
                    <TD className="tabular text-right">{formatCurrency(r.price)}</TD>
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
      <InventoryDrawer itemId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
