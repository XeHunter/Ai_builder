import type { RecStatus, RecType } from "./types";

export type RecAction = "accept" | "reject" | "apply" | "implement" | "complete";

/** Workflow actions available for a recommendation (mirrors REC_TRANSITIONS in merchandising_service.py). */
export function actionsForStatus(
  status: RecStatus,
  opts: { canManage: boolean; canWriteLayout: boolean; hasProposedLocation: boolean },
): RecAction[] {
  const out: RecAction[] = [];
  const apply = opts.canWriteLayout && opts.hasProposedLocation;
  if (status === "proposed") {
    if (opts.canManage) out.push("accept");
    if (apply) out.push("apply");
    if (opts.canManage) out.push("reject");
  } else if (status === "accepted") {
    if (apply) out.push("apply");
    if (opts.canManage) out.push("implement", "reject");
  } else if (status === "implemented") {
    if (opts.canManage) out.push("complete");
  }
  return out;
}

export const REC_TYPE: Record<RecType, { label: string; variant: "info" | "accent" | "danger" }> = {
  adjacency_test: { label: "Adjacency test", variant: "info" },
  eye_level_test: { label: "Eye-level test", variant: "accent" },
  safety_relocation: { label: "Safety relocation", variant: "danger" },
};

const EVIDENCE_LABELS: Record<string, string> = {
  support: "Support (share of baskets)",
  confidence: "Confidence",
  lift: "Lift",
  pair_count: "Baskets with both",
  transactions_analyzed: "Transactions analysed",
  walking_distance_m: "Walking distance",
  affinity_window_days: "Analysis window",
  weight_kg: "Product weight",
  height_cm: "Current shelf height",
  policy_max_cm: "Policy max height (heavy items)",
  units_per_day_30d: "Units / day (30 d)",
  gross_margin_pct: "Gross margin",
  current_level: "Current level",
  proposed_level: "Proposed level",
};

export function formatEvidence(key: string, value: number | string | null): [string, string] {
  const label = EVIDENCE_LABELS[key] ?? key.replace(/_/g, " ");
  if (value === null || value === undefined) return [label, "—"];
  if (typeof value === "string") return [label, value];
  switch (key) {
    case "support":
      return [label, `${(value * 100).toFixed(2)}%`];
    case "confidence":
      return [label, `${(value * 100).toFixed(1)}%`];
    case "lift":
      return [label, `${value.toFixed(2)}×`];
    case "walking_distance_m":
      return [label, `${value.toFixed(1)} m`];
    case "affinity_window_days":
      return [label, `${value} days`];
    case "weight_kg":
      return [label, `${value} kg`];
    case "height_cm":
    case "policy_max_cm":
      return [label, `${value} cm`];
    case "gross_margin_pct":
      return [label, `${value.toFixed(1)}%`];
    default:
      return [label, value.toLocaleString("en-IN", { maximumFractionDigits: 2 })];
  }
}
