import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { JobOut } from "@/types/api";

/** Poll a background job until it finishes. */
export function useJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["merchant", "job", jobId],
    queryFn: () => api.get<JobOut>(`/merchant/jobs/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data && ["succeeded", "failed"].includes(q.state.data.status) ? false : 1500),
  });
}
