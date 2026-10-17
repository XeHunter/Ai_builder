/**
 * Store selection.
 * - Shoppers: the store they are shopping at (persisted to their profile and localStorage).
 * - Merchants: a store filter ("all" or a specific store) applied to dashboards.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useAuth } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import type { MerchantStore, Store } from "@/types/api";

interface ShopperStoreValue {
  stores: Store[];
  store: Store | null;
  storeId: string | null;
  setStoreId: (id: string) => void;
  isLoading: boolean;
}

const ShopperStoreContext = React.createContext<ShopperStoreValue | null>(null);
const LS_SHOP = "op.shop.store";
const LS_MERCHANT = "op.merchant.store";

export function ShopperStoreProvider({ children }: { children: React.ReactNode }) {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["stores"], queryFn: () => api.get<Store[]>("/stores"), staleTime: 10 * 60_000 });
  const [storeId, setStoreIdState] = React.useState<string | null>(() => localStorage.getItem(LS_SHOP));
  const stores = React.useMemo(() => q.data ?? [], [q.data]);

  React.useEffect(() => {
    if (!stores.length) return;
    if (!storeId || !stores.some((s) => s.id === storeId)) {
      const preferred = me?.user.preferred_store_id;
      setStoreIdState(stores.find((s) => s.id === preferred)?.id ?? stores[0].id);
    }
  }, [stores, storeId, me?.user.preferred_store_id]);

  const setStoreId = React.useCallback(
    (id: string) => {
      setStoreIdState(id);
      localStorage.setItem(LS_SHOP, id);
      api.patch("/auth/me", { preferred_store_id: id }).then(refresh).catch(() => undefined);
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] === "store" });
    },
    [qc, refresh],
  );

  const value = React.useMemo(
    () => ({ stores, store: stores.find((s) => s.id === storeId) ?? null, storeId, setStoreId, isLoading: q.isLoading }),
    [stores, storeId, setStoreId, q.isLoading],
  );
  return <ShopperStoreContext.Provider value={value}>{children}</ShopperStoreContext.Provider>;
}

export function useShopperStore(): ShopperStoreValue {
  const ctx = React.useContext(ShopperStoreContext);
  if (!ctx) throw new Error("useShopperStore must be used inside ShopperStoreProvider");
  return ctx;
}

interface MerchantStoreValue {
  stores: MerchantStore[];
  /** Selected store id, or null for "all stores". */
  storeId: string | null;
  setStoreId: (id: string | null) => void;
  /** A concrete store for pages that need one (selected store or the first store). */
  concreteStoreId: string | null;
  isLoading: boolean;
}

const MerchantStoreContext = React.createContext<MerchantStoreValue | null>(null);

export function MerchantStoreProvider({ children }: { children: React.ReactNode }) {
  const q = useQuery({ queryKey: ["merchant", "stores"], queryFn: () => api.get<MerchantStore[]>("/merchant/stores"), staleTime: 10 * 60_000 });
  const [storeId, setStoreIdState] = React.useState<string | null>(() => localStorage.getItem(LS_MERCHANT) || null);
  const stores = React.useMemo(() => q.data ?? [], [q.data]);
  const valid = storeId && stores.some((s) => s.id === storeId) ? storeId : null;
  const value = React.useMemo(
    () => ({
      stores,
      storeId: valid,
      setStoreId: (id: string | null) => {
        setStoreIdState(id);
        if (id) localStorage.setItem(LS_MERCHANT, id);
        else localStorage.removeItem(LS_MERCHANT);
      },
      concreteStoreId: valid ?? stores[0]?.id ?? null,
      isLoading: q.isLoading,
    }),
    [stores, valid, q.isLoading],
  );
  return <MerchantStoreContext.Provider value={value}>{children}</MerchantStoreContext.Provider>;
}

export function useMerchantStore(): MerchantStoreValue {
  const ctx = React.useContext(MerchantStoreContext);
  if (!ctx) throw new Error("useMerchantStore must be used inside MerchantStoreProvider");
  return ctx;
}
