/** Types for layout (planogram) and merchandising-recommendation endpoints (backend/app/api/v1/merchandising.py). */

export interface LayoutSummary {
  id: string;
  name: string;
  version: number;
  status: "active" | "draft" | "archived";
  published_at: string | null;
  created_at: string;
}

export type ViolationCode = "unsafe_height" | "needs_refrigeration" | "capacity" | "child_checkout" | "chiller_space" | string;

export interface Violation {
  severity: "block" | "warn";
  code: ViolationCode;
  message: string;
}

export interface PlaceResult {
  placement_id: string;
  shelf_code: string;
  warnings: Violation[];
}

export interface LayoutDiff {
  base_layout_id: string;
  layout_id: string;
  changes: { product_id: string; name: string | null; current: string[]; proposed: string[] }[];
}

export interface MerchantProduct {
  id: string;
  sku: string;
  name: string;
  category_name: string | null;
  brand: string | null;
  unit: string;
  price: number;
  is_perishable: boolean;
  is_child_product: boolean;
  weight_kg: number | null;
  total_stock: number | null;
  status: string;
}

export type RecType = "adjacency_test" | "eye_level_test" | "safety_relocation";
export type RecStatus = "proposed" | "accepted" | "rejected" | "implemented" | "completed";

export interface RecLocation {
  id: string;
  code: string;
  level: number;
  fixture: string;
  x: number;
  y: number;
}

export interface AbTestPlan {
  design?: string;
  primary_metric?: string;
  baseline_rate?: number;
  minimum_detectable_change?: number;
  baskets_needed_per_arm?: number;
  estimated_duration_weeks?: number;
  stop_rule?: string;
}

export interface OutcomeWindow {
  baskets?: number;
  attach_rate?: number | null;
  units_per_day?: number;
}

export interface Outcome {
  status?: string;
  before?: OutcomeWindow;
  after?: OutcomeWindow;
  window_days?: number;
  method?: string;
  caveat?: string;
}

export interface Recommendation {
  id: string;
  store_id: string;
  rec_type: RecType | string;
  title: string;
  product_id: string;
  product: string;
  related_product_id: string | null;
  related_product: string | null;
  current_location: RecLocation | null;
  proposed_location: RecLocation | null;
  rationale: string;
  evidence: Record<string, number | string | null>;
  evidence_quality: "high" | "medium" | "low" | string;
  expected_metric: string;
  implementation_steps: string[];
  ab_test_plan: AbTestPlan;
  status: RecStatus;
  review_note: string | null;
  implemented_at: string | null;
  outcome: Outcome | Record<string, never>;
  created_at: string;
  live_outcome?: Outcome;
}

export interface ApplyResult extends PlaceResult {
  draft_layout_id: string;
}
