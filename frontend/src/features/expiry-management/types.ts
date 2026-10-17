/** Types for /merchant/expiry endpoints (backend/app/api/v1/expiry.py). */

export interface ExpiryBatch {
  batch_id: string;
  store_id: string;
  store_code: string;
  product_id: string;
  product: string;
  sku: string;
  batch_code: string;
  expiry_date: string;
  hours_to_sell_by: number;
  quantity_remaining: number;
  daily_velocity: number;
  expected_sell_through: number;
  units_at_risk: number;
  value_at_risk: number;
  status: string;
  markdown_price: number | null;
  in_clearance: boolean;
  price_change: { id: string; status: string; discount_pct: number; proposed_price: number } | null;
  priority: number;
}

export interface ExpiryAlert {
  id: string;
  store_id: string;
  batch_id: string;
  product: string;
  batch_code: string;
  severity: "warning" | "critical" | "expired" | string;
  hours_to_expiry: number;
  quantity_at_alert: number;
  status: "open" | "acknowledged" | "resolved" | string;
  message: string;
  created_at: string;
}

export interface StoreTask {
  id: string;
  store_id: string;
  task_type: string;
  title: string;
  instruction: string;
  status: "open" | "done" | string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface EvaluationOutcome {
  batch_id: string;
  product: string;
  hours_left: number;
  quantity: number;
  actions: string[];
  severity?: string;
  price_change_id?: string;
  decision?: { action: string; discount_pct: number; reasons: string[] };
}

export interface StoreEvaluation {
  store: string;
  batches_evaluated: number;
  results: EvaluationOutcome[];
  price_changes_expired: number;
}
