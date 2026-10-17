import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { api } from "@/lib/api";
import type { Category, ProductCard, ProductSearchResponse } from "@/types/api";

export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export interface ProductQuery {
  q?: string;
  category_id?: string | null;
  page?: number;
  page_size?: number;
}

export function useStoreProducts(storeId: string | null, params: ProductQuery, enabled = true) {
  return useQuery({
    queryKey: ["store", storeId, "products", params],
    queryFn: ({ signal }) =>
      api.get<ProductSearchResponse>(
        `/stores/${storeId}/products`,
        { q: params.q?.trim() || undefined, category_id: params.category_id ?? undefined, page: params.page ?? 1, page_size: params.page_size ?? 24 },
        signal,
      ),
    enabled: !!storeId && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCategories(storeId: string | null) {
  return useQuery({
    queryKey: ["store", storeId, "categories"],
    queryFn: () => api.get<Category[]>(`/stores/${storeId}/categories`),
    enabled: !!storeId,
    staleTime: 5 * 60_000,
  });
}

export interface ProductDetail {
  product: ProductCard;
  complementary: ProductCard[];
  complement_reasons: Record<string, string>;
}

export function useProductDetail(storeId: string | null, productId: string | null | undefined) {
  return useQuery({
    queryKey: ["store", storeId, "product", productId],
    queryFn: () => api.get<ProductDetail>(`/stores/${storeId}/products/${productId}`),
    enabled: !!storeId && !!productId,
  });
}
