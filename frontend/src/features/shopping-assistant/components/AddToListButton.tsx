/** "Add to list" picker: the shopper's editable lists for the current store, or a new "Quick list". */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { useShopperStore } from "@/hooks/use-stores";
import { api, errorMessage } from "@/lib/api";
import type { ListSummary, ShoppingListView } from "@/types/api";

export const MY_LISTS_KEY = ["shopping-lists"] as const;
const QUICK_LIST = "Quick list";

export function useMyLists() {
  return useQuery({ queryKey: MY_LISTS_KEY, queryFn: () => api.get<ListSummary[]>("/shopping-lists") });
}

interface Props {
  productId: string;
  productName: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}

export function AddToListButton({ productId, productName, size = "sm", variant = "outline", className }: Props) {
  const { store, storeId } = useShopperStore();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lists = useMyLists();
  // ListSummary carries the store name (not id), so lists are matched to the selected store by name.
  const editable = (lists.data ?? []).filter((l) => l.my_role !== "viewer" && l.status !== "archived" && l.store_id === store?.id);
  const hasQuick = editable.some((l) => l.name === QUICK_LIST);

  const add = useMutation({
    mutationFn: async (target: { id: string; name: string } | null) => {
      if (target) {
        await api.post(`/shopping-lists/${target.id}/items`, { product_id: productId, quantity: 1 });
        return target;
      }
      const created = await api.post<ShoppingListView>("/shopping-lists", {
        name: QUICK_LIST,
        store_id: storeId,
        items: [{ product_id: productId, quantity: 1 }],
      });
      return { id: created.id, name: created.name };
    },
    onSuccess: (target) => {
      void qc.invalidateQueries({ queryKey: MY_LISTS_KEY });
      void qc.invalidateQueries({ queryKey: ["shopping-list", target.id] });
      toast.success(`Added ${productName} to “${target.name}”`, {
        action: { label: "View list", onClick: () => navigate(`/shop/lists/${target.id}`) },
      });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={variant} className={className} loading={add.isPending} aria-label={`Add ${productName} to a list`}>
          <ListPlus aria-hidden /> Add to list
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel>Add to a list{store ? ` for ${store.name}` : ""}</DropdownMenuLabel>
        {lists.isLoading && <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading your lists…</p>}
        {lists.isError && <p className="px-2 py-1.5 text-sm text-danger">Could not load your lists.</p>}
        {editable.map((l) => (
          <DropdownMenuItem key={l.id} onSelect={() => add.mutate({ id: l.id, name: l.name })}>
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
            <span className="text-xs text-muted-foreground">{l.item_count} items</span>
          </DropdownMenuItem>
        ))}
        {!lists.isLoading && editable.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">You have no lists for this store yet.</p>
        )}
        {!hasQuick && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => add.mutate(null)} disabled={!storeId}>
              <Plus aria-hidden /> Create “{QUICK_LIST}”
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
