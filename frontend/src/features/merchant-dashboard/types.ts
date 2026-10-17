/** Response types for the merchant dashboard, settings and integrations endpoints (backend/app/api/v1/analytics.py). */

export interface OverviewKpis {
  total_products: number;
  total_stock_units: number;
  low_stock_products: number;
  out_of_stock_products: number;
  expiring_batches_3d: number;
  stockout_risk_high: number;
  stockout_risk_medium: number;
  active_promotions: number;
  pending_price_recommendations: number;
  pending_merchandising_recommendations: number;
  flagged_transactions: number;
  open_store_tasks: number;
  net_revenue: number;
  transactions: number;
  net_revenue_previous_period: number;
  revenue_change_pct: number | null;
}

export interface OverviewAlert {
  kind: string;
  severity: string;
  title: string;
  link: string;
}

export interface Overview {
  is_demo_data: boolean;
  window_days: number;
  kpis: OverviewKpis;
  sales_trend: { date: string; revenue: number; transactions: number; returns: number }[];
  category_revenue: { category: string; revenue: number }[];
  top_products: { product_id: string; name: string; units: number; revenue: number }[];
  alerts: OverviewAlert[];
}

export interface AuditEvent {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  actor: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
  created_at: string;
}

export interface Integration {
  kind: string;
  providers: string[];
  env_vars: string[];
  configured_provider: string | null;
  mode: "simulated" | "live" | "disabled";
  settings: Record<string, unknown>;
  status: string;
  last_checked_at: string | null;
  live_capable: boolean;
  active_provider: string;
  details?: Record<string, unknown>;
}
