import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Layout } from "@/types/api";

/** Active floor plan for a store (fixtures, shelves, walkable graph). */
export function useFloorplan(storeId: string | null | undefined) {
  return useQuery({
    queryKey: ["store", storeId, "floorplan"],
    queryFn: () => api.get<Layout>(`/stores/${storeId}/floorplan`),
    enabled: !!storeId,
    staleTime: 5 * 60_000,
  });
}
