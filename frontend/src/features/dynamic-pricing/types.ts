/** Types for /merchant/pricing and /merchant/promotions endpoints (backend/app/api/v1/pricing.py, promotions.py). */

export type PriceChangeStatus = "RECOMMENDED" | "PENDING_APPROVAL" | "APPROVED" | "PUBLISHED" | "FAILED" | "REJECTED" | "CANCELLED" | "EXPIRED";

export interface PriceChangeEvidence {
  method?: string;
  assumption?: string;
  hours_to_sell_by?: number;
  sell_by_deadline?: string;
  remaining_units?: number;
  daily_velocity_14d?: number;
  expected_units_no_action?: number;
  expected_units_with_action?: number;
  expected_leftover_units?: number;
  tier_cap_pct?: number;
  floor_price?: number;
  unit_cost?: number;
  reasons?: string[];
  [key: string]: unknown;
}

export interface PriceChangeEvent {
  from: string | null;
  to: string;
  actor: string;
  note: string | null;
  at: string;
}

export interface PriceChange {
  id: string;
  store_id: string;
  store_code: string;
  product_id: string;
  product: string;
  sku: string;
  batch_id: string | null;
  batch_code: string | null;
  source: string;
  status: PriceChangeStatus;
  current_price: number;
  proposed_price: number;
  discount_pct: number;
  floor_price: number;
  unit_cost: number;
  projected_margin_pct: number;
  quantity_affected: number;
  reason: string;
  evidence: PriceChangeEvidence;
  clearance_instruction: string | null;
  publish_reference: string | null;
  failure_reason: string | null;
  requested_by: string | null;
  approved_by: string | null;
  created_at: string;
  approved_at: string | null;
  published_at: string | null;
  effective_until: string | null;
  events: PriceChangeEvent[];
}

export type PromotionStatus = "draft" | "pending_approval" | "scheduled" | "active" | "paused" | "ended" | "rejected" | "cancelled";

export interface PromotionProduct {
  product_id: string;
  name: string;
  sku: string;
  regular_price: number;
  promo_price: number;
  margin_at_promo_pct: number | null;
}

export interface Promotion {
  id: string;
  name: string;
  description: string;
  store_id: string | null;
  store_name: string;
  promo_type: "percent_off" | "amount_off";
  discount_value: number;
  status: PromotionStatus;
  trigger: string;
  starts_at: string;
  ends_at: string;
  usage_limit: number | null;
  per_customer_limit: number;
  usage_count: number;
  geofence_radius_m: number | null;
  is_simulation: boolean;
  evidence: Record<string, unknown>;
  products: PromotionProduct[];
  approved_at: string | null;
  created_at: string;
}

export interface PromotionPerformance {
  coupons_issued: number;
  redemptions: number;
  window_days: number;
  units_during: number;
  units_before: number;
  change_pct: number | null;
  method: string;
  caveat: string;
}

export interface PromotionDetail extends Promotion {
  performance: PromotionPerformance;
}

export interface PromotionPayload {
  name: string;
  description: string;
  store_id: string | null;
  product_ids: string[];
  promo_type: "percent_off" | "amount_off";
  discount_value: number;
  starts_at: string;
  ends_at: string;
  usage_limit: number | null;
  per_customer_limit: number;
  geofence_radius_m: number | null;
  trigger: "manual" | "weather" | "expiry" | "overstock";
  evidence: Record<string, unknown>;
}

export interface SimulationLine {
  product_id: string;
  name: string;
  regular_price: number;
  promo_price: number;
  baseline_units: number;
  margin_regular: number;
  margin_at_promo_same_volume: number;
  breakeven_volume_increase_pct: number | null;
}

export interface SimulationResult {
  valid: boolean;
  issues: { product_id: string; sku: string; name: string; promo_price: number; floor_price: number; problems: string[] }[];
  window_days: number;
  lines: SimulationLine[];
  method: string;
  caveat: string;
}

export interface Policy {
  auto_publish_markdowns: boolean;
  auto_publish_max_pct: number;
  max_markdown_pct: number;
  min_margin_pct: number;
  expiry_warning_days: number;
  expiry_critical_hours: number;
  sell_by_buffer_hours: number;
  low_stock_threshold_days: number;
  forecast_horizon_days: number;
  fraud_alert_threshold: number;
  default_geofence_radius_m: number;
  notification_cooldown_minutes: number;
  clearance_location_code: string | null;
}

export type RuleType = "expiry_markdown" | "weather_promotion" | "overstock_clearance";

export interface PricingRule {
  id: string;
  store_id: string | null;
  name: string;
  rule_type: RuleType;
  is_active: boolean;
  priority: number;
  conditions: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

export interface WeatherDay {
  date: string;
  temp_max_c: number | null;
  temp_min_c: number | null;
  precipitation_mm: number;
  condition: string;
  source: string;
}

export interface WeatherCandidate {
  product_id: string;
  name: string;
  sku: string;
  regular_price: number;
  promo_price: number;
  floor_price: number;
  stock: number;
  expected_units_3d: number;
  evidence: { rain_days_observed: number; dry_days_observed: number; avg_units_rain: number; avg_units_dry: number; ratio: number | null };
  checks: { rain_forecast: boolean; historical_association: boolean; stock_sufficient: boolean; promotion_eligible: boolean; above_price_floor: boolean };
  qualifies: boolean;
}

export interface WeatherOpportunities {
  store_id: string;
  weather_source: string;
  forecast: WeatherDay[];
  rain_days: string[];
  discount_pct: number;
  candidates: WeatherCandidate[];
  recommendation: {
    name: string;
    product_ids: string[];
    discount_pct: number;
    starts_at: string;
    ends_at: string;
    geofence_radius_m: number;
    rationale: string;
  } | null;
  method: string;
}
