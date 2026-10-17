/** Types for the channels & connectors endpoints (backend/app/api/v1/channels.py) and the AI brief. */

export type SalesChannel = "pos" | "self_checkout" | "online";
export type KeyChannel = "pos" | "ecommerce" | "payments" | "other";
export type KeyProvider = "generic" | "shopify" | "woocommerce" | "custom";
export type PaymentMethod = "upi" | "card" | "cash" | "wallet";

export interface Connector {
  key: string;
  channel: string;
  name: string;
  description: string;
  auth: "api_key" | "session" | "none";
  mode: "live" | "simulated";
}

export interface ApiKeyView {
  id: string;
  name: string;
  channel: string;
  provider: string;
  prefix: string;
  store_id: string | null;
  store_code: string | null;
  created_at: string;
  last_used_at: string | null;
  usage_count: number;
  revoked: boolean;
}

export interface ApiKeyCreated extends ApiKeyView {
  secret: string;
}

export interface ChannelsOverview {
  connectors: Connector[];
  keys: ApiKeyView[];
  today: Partial<Record<SalesChannel, { orders: number; revenue: number }>>;
  realtime: "firestore" | "polling";
  endpoints: { orders: string; shopify_orders: string; catalog_feed: string };
}

export interface OrderLineView {
  sku: string | null;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface ChannelOrder {
  id: string;
  receipt_number: string;
  channel: SalesChannel | string;
  store_id: string;
  store_code: string | null;
  store_name: string | null;
  occurred_at: string;
  total: number;
  item_count: number;
  payment_method: string;
  is_simulated: boolean;
  customer: string | null;
  lines: OrderLineView[];
}

export interface LowStockWarning {
  sku: string;
  name: string;
  on_hand: number;
  reorder_point: number;
  reorder_quantity: number;
}

export interface Shortfall {
  sku: string;
  name: string;
  requested: number;
  available: number;
}

export interface SimulatedOrder extends ChannelOrder {
  duplicate: boolean;
  low_stock: LowStockWarning[];
  shortfalls: Shortfall[];
}

export type BriefPriority = "high" | "medium" | "low";

export interface BriefAction {
  title: string;
  detail: string;
  priority: BriefPriority;
  fact_ids: string[];
  link: string;
  evidence: string[];
}

export interface BriefFact {
  id: string;
  kind: string;
  priority: BriefPriority;
  title: string;
  text: string;
  action: string;
  link: string;
}

export interface AiBrief {
  headline: string;
  actions: BriefAction[];
  provider: "gemini" | "openai" | "demo" | string;
  model: string | null;
  fell_back: boolean;
  generated_at: string;
  cached: boolean;
  facts: {
    kpis: {
      orders_today?: number;
      online_orders_today?: number;
      revenue_7d?: number;
      revenue_change_pct?: number | null;
      low_stock_products?: number;
      expiring_batches_3d?: number;
    };
    facts: BriefFact[];
  };
}
