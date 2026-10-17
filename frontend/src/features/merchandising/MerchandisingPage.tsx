/** Merchandising recommendations: evidence-based layout experiments with a review → implement → measure workflow. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Sparkles } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { PageHeader, StatCard } from "@/components/ui/data";
import { useAuth } from "@/features/auth/auth-context";
import { useMerchantStore } from "@/hooks/use-stores";
import { api } from "@/lib/api";

import { plainError } from "./layout-api";
import { RecommendationCard } from "./RecommendationCard";
import type { Recommendation } from "./types";

const STATUSES = ["proposed", "accepted", "implemented", "completed", "rejected"] as const;

export default function MerchandisingPage() {
  const { storeId, concreteStoreId, stores } = useMerchantStore();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = React.useState<string>("");

  const recs = useQuery({
    queryKey: ["merchant", "merch-recs", storeId, status],
    queryFn: () => api.get<Recommendation[]>("/merchant/merchandising/recommendations", { store_id: storeId, status: status || undefined }),
  });
  const all = useQuery({
    queryKey: ["merchant", "merch-recs", storeId, "__all"],
    queryFn: () => api.get<Recommendation[]>("/merchant/merchandising/recommendations", { store_id: storeId }),
  });
  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of all.data ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [all.data]);

  const genStore = stores.find((s) => s.id === concreteStoreId);
  const generate = useMutation({
    mutationFn: () => api.post<{ created: number }>("/merchant/merchandising/recommendations/generate", undefined, { store_id: concreteStoreId }),
    onSuccess: (r) => {
      if (r.created) toast.success(`${r.created} new recommendation${r.created === 1 ? "" : "s"} for ${genStore?.name ?? "the store"}`);
      else toast.info("No new recommendations: open ones already cover the current evidence.");
      void qc.invalidateQueries({ queryKey: ["merchant", "merch-recs"] });
    },
    onError: (err) => toast.error(plainError(err)),
  });

  return (
    <>
      <PageHeader
        eyebrow="Merchandising"
        title="Merchandising recommendations"
        description="Layout experiments grounded in basket analysis, sales velocity and safety policy. Review, apply to a draft layout, implement and measure."
        actions={
          can("merchandising.manage") && (
            <Button onClick={() => generate.mutate()} loading={generate.isPending} disabled={!concreteStoreId}>
              <Sparkles /> Generate recommendations{genStore && !storeId ? ` (${genStore.code})` : ""}
            </Button>
          )
        }
      />

      <Callout tone="warning" title="Hypotheses to test, not guaranteed uplift" className="mb-4">
        Each recommendation is an experiment with a stated metric, sample size and stop rule. Co-purchase patterns are
        correlations and do not prove that moving a product will change behaviour. Children’s products are never targeted
        with checkout or eye-level placements. Safety relocations are policy corrections, not experiments.
      </Callout>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {STATUSES.map((s) => (
          <StatCard key={s} label={s} value={all.isLoading ? "…" : counts[s] ?? 0} onClick={() => setStatus(status === s ? "" : s)} />
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="rec-status" className="text-sm font-medium">
          Status
        </label>
        <Select id="rec-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-48">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
        {recs.data && <span className="text-sm text-muted-foreground">{recs.data.length} shown</span>}
      </div>

      {recs.isLoading ? (
        <SkeletonRows rows={4} />
      ) : recs.isError ? (
        <ErrorState error={recs.error} onRetry={() => void recs.refetch()} />
      ) : !recs.data?.length ? (
        <EmptyState
          icon={Lightbulb}
          title={status ? `No ${status} recommendations` : "No recommendations yet"}
          description="Generate recommendations to analyse the active layout against recent baskets. Run a cross-selling analysis first for adjacency tests."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {recs.data.map((r) => (
            <RecommendationCard key={r.id} rec={r} showMap={recs.data.length <= 3} />
          ))}
        </div>
      )}
    </>
  );
}
