/** Query hooks and helpers shared by the layout editor and merchandising pages. */
import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import type { Layout } from "@/types/api";

import type { LayoutSummary, Violation } from "./types";

export const layoutKeys = {
  list: (storeId: string | null) => ["merchant", "layouts", storeId] as const,
  detail: (layoutId: string | null) => ["merchant", "layout", layoutId] as const,
  diff: (layoutId: string | null) => ["merchant", "layout-diff", layoutId] as const,
};

export function useStoreLayouts(storeId: string | null) {
  return useQuery({
    queryKey: layoutKeys.list(storeId),
    queryFn: () => api.get<LayoutSummary[]>(`/merchant/stores/${storeId}/layouts`),
    enabled: Boolean(storeId),
  });
}

export function useLayout(layoutId: string | null | undefined) {
  return useQuery({
    queryKey: layoutKeys.detail(layoutId ?? null),
    queryFn: () => api.get<Layout>(`/merchant/layouts/${layoutId}`),
    enabled: Boolean(layoutId),
  });
}

/** The store's active layout (list + detail), cached for 5 minutes. */
export function useActiveLayout(storeId: string | null) {
  const list = useStoreLayouts(storeId);
  const activeId = list.data?.find((l) => l.status === "active")?.id ?? null;
  const detail = useQuery({
    queryKey: layoutKeys.detail(activeId),
    queryFn: () => api.get<Layout>(`/merchant/layouts/${activeId}`),
    enabled: Boolean(activeId),
    staleTime: 5 * 60_000,
  });
  return { layout: detail.data ?? null, isLoading: list.isLoading || detail.isLoading, error: list.error ?? detail.error };
}

/** Constraint violations attached to a 422 placement error (error.details.violations). */
export function violationsFrom(err: unknown): Violation[] {
  if (!(err instanceof ApiError)) return [];
  const v = (err.details as { violations?: unknown } | null)?.violations;
  if (!Array.isArray(v)) return [];
  return v
    .map((x): Violation | null => {
      if (typeof x === "string") return { severity: "block", code: "rule", message: x };
      if (x && typeof x === "object" && "message" in x) {
        const o = x as Partial<Violation>;
        return { severity: o.severity === "warn" ? "warn" : "block", code: String(o.code ?? "rule"), message: String(o.message) };
      }
      return null;
    })
    .filter((x): x is Violation => x !== null);
}

/** Plain error text without the (object) violations that `errorMessage` would try to join. */
export function plainError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}

export const VIOLATION_LABEL: Record<string, string> = {
  unsafe_height: "Unsafe height",
  needs_refrigeration: "Needs refrigeration",
  capacity: "Shelf capacity",
  child_checkout: "Child product at checkout",
  chiller_space: "Chiller space",
};
