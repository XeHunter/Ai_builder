/**
 * The placement rule book with live compliance for the layout being viewed. Rules come from the API
 * (`layout_service.PLACEMENT_RULES`), i.e. exactly what the planogram editor enforces and what the
 * merchandising AI is allowed to recommend.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ScrollText, Sparkles } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface PlacementRule {
  code: string;
  kind: "block" | "warn" | "ai";
  group: string;
  title: string;
  description: string;
  why: string;
  checked: boolean;
  violations: number;
  examples: { product: string; sku: string; shelf_code: string; height_cm: number; message: string }[];
}

export interface RuleBook {
  layout_id: string;
  layout_name: string;
  status: string;
  placements_checked: number;
  kid_targeted_products: number;
  blocking: number;
  warnings: number;
  rules: PlacementRule[];
}

export const ruleBookKey = (layoutId: string | null) => ["merchant", "layout", layoutId, "rules"] as const;

const KIND: Record<PlacementRule["kind"], { label: string; variant: "danger" | "warning" | "accent"; icon: typeof Ban }> = {
  block: { label: "Hard rule", variant: "danger", icon: Ban },
  warn: { label: "Warning", variant: "warning", icon: AlertTriangle },
  ai: { label: "AI policy", variant: "accent", icon: Sparkles },
};

export function PlacementRulesCard({ layoutId }: { layoutId: string | null }) {
  const q = useQuery({
    queryKey: ruleBookKey(layoutId),
    queryFn: () => api.get<RuleBook>(`/merchant/layouts/${layoutId}/rules`),
    enabled: Boolean(layoutId),
  });
  const [open, setOpen] = React.useState<string | null>(null);

  const groups = React.useMemo(() => {
    const out = new Map<string, PlacementRule[]>();
    for (const r of q.data?.rules ?? []) out.set(r.group, [...(out.get(r.group) ?? []), r]);
    return [...out.entries()];
  }, [q.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="size-4" aria-hidden /> Placement rules
        </CardTitle>
        <CardDescription>What the editor enforces and what the AI may recommend, checked against this layout.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <Stat label="Placements checked" value={q.data.placements_checked} />
              <Stat label="Rule breaks" value={q.data.blocking} tone={q.data.blocking ? "danger" : "success"} />
              <Stat label="Warnings" value={q.data.warnings} tone={q.data.warnings ? "warning" : "success"} />
            </div>
            {groups.map(([group, rules]) => (
              <section key={group} aria-label={group} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</h3>
                {rules.map((r) => {
                  const k = KIND[r.kind];
                  const expanded = open === r.code;
                  const ok = r.violations === 0;
                  return (
                    <div key={r.code} className="rounded-md border border-border">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : r.code)}
                        className="flex w-full items-start gap-2 p-2.5 text-left text-sm hover:bg-muted"
                      >
                        {!r.checked ? (
                          <k.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                        ) : ok ? (
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Compliant" />
                        ) : (
                          <k.icon className={cn("mt-0.5 size-4 shrink-0", r.kind === "block" ? "text-danger" : "text-warning")} aria-hidden />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{r.title}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{r.description}</span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <Badge variant={k.variant}>{k.label}</Badge>
                          {r.checked && !ok && (
                            <span className={cn("text-xs font-medium", r.kind === "block" ? "text-danger" : "text-warning")}>
                              {r.violations} found
                            </span>
                          )}
                        </span>
                        <ChevronDown className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition", expanded && "rotate-180")} aria-hidden />
                      </button>
                      {expanded && (
                        <div className="border-t border-border px-3 py-2 text-xs">
                          <p>
                            <span className="font-medium">Why: </span>
                            {r.why}
                          </p>
                          {r.examples.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {r.examples.map((e) => (
                                <li key={`${e.sku}-${e.shelf_code}`} className="rounded bg-muted px-2 py-1">
                                  <span className="font-medium">{e.product}</span> on{" "}
                                  <span className="font-mono">{e.shelf_code}</span> ({e.height_cm} cm)
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            <p className="text-xs text-muted-foreground">
              {q.data.kid_targeted_products} confectionery and children&rsquo;s products are covered by the responsible-retail rules.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className="rounded-md bg-muted px-2 py-2">
      <div
        className={cn(
          "tabular text-lg font-semibold",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  );
}
