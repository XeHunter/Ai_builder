/** Types for the merchant catalog and inventory endpoints (backend/app/api/v1/products.py, inventory.py). */

export interface AdminProduct {
  id: string;
  sku: string;
  name: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  brand: string | null;
  unit: string;
  price: number;
  cost_price: number;
  min_allowed_price: number | null;
  target_segment: string | null;
  promotion_eligible: boolean;
  is_perishable: boolean;
  is_child_product: boolean;
  weight_kg: number | null;
  tags: string[];
  status: "active" | "archived";
  total_stock: number | null;
  margin_pct: number | null;
}

export interface MerchantCategory {
  id: string;
  name: string;
  slug: string;
  is_perishable: boolean;
  requires_chilling: boolean;
}

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export interface InventoryRow {
  id: string;
  store_id: string;
  store_code: string;
  product_id: string;
  sku: string;
  name: string;
  category: string | null;
  is_perishable: boolean;
  quantity_on_hand: number;
  reorder_point: number;
  reorder_quantity: number;
  price: number;
  stock_status: StockStatus;
  shelf_code: string | null;
  next_expiry: string | null;
  batch_count: number;
}

export interface Batch {
  id: string;
  batch_code: string;
  quantity_received: number;
  quantity_remaining: number;
  received_at: string;
  expiry_date: string | null;
  days_to_expiry: number | null;
  status: string;
  markdown_price: number | null;
  markdown_pct: number | null;
  in_clearance: boolean;
}

export interface Adjustment {
  id: string;
  delta: number;
  quantity_after: number;
  reason: string;
  note: string | null;
  reference: string | null;
  actor: string;
  created_at: string;
}

export interface InventoryDetail extends InventoryRow {
  batches: Batch[];
  adjustments: Adjustment[];
}

export interface ImportSummary {
  would_create_products?: number;
  rows_creating?: number;
  rows_updating?: number;
  unknown_columns?: string[];
  previously_imported_at?: string | null;
  products_created?: number;
  products_updated?: number;
  batches_created?: number;
  batches_updated?: number;
  placements_set?: number;
  units_delta?: number;
}

export interface ImportJob {
  id: string;
  filename: string;
  status: "validated" | "committing" | "completed" | "cancelled" | "failed" | string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  warning_rows: number;
  summary: ImportSummary;
  error_message: string | null;
  created_at: string;
  committed_at: string | null;
}

export interface FieldMessage {
  field: string;
  message: string;
}

export interface ImportRow {
  row_number: number;
  is_valid: boolean;
  action: string;
  raw: Record<string, string>;
  normalized: Record<string, unknown> | null;
  errors: FieldMessage[];
  warnings: FieldMessage[];
}

export interface CommitResponse {
  job_id: string | null;
  job_status?: string;
  import: ImportJob;
}
