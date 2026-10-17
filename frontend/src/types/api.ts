/** Types mirroring the backend response schemas (backend/app/schemas, backend/app/api/v1). */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface UserOut {
  id: string;
  email: string;
  full_name: string;
  account_type: "customer" | "merchant";
  preferred_store_id: string | null;
}

export interface MerchantAccess {
  merchant_id: string;
  merchant_name: string;
  role: string;
  permissions: string[];
  all_stores: boolean;
  store_ids: string[];
}

export interface Me {
  user: UserOut;
  merchant: MerchantAccess | null;
}

export interface Store {
  id: string;
  code: string;
  name: string;
  address: string;
  city: string;
  latitude: number;
  longitude: number;
  geofence_radius_m: number;
  merchant_id: string;
}

export interface LocationView {
  shelf_location_id: string;
  shelf_code: string;
  aisle_code: string | null;
  aisle_label: string;
  fixture_label: string;
  level: number;
  x: number;
  y: number;
}

export interface ProductCard {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  description: string;
  unit: string;
  category: { id: string; name: string } | null;
  price: number;
  promotion: { id: string; name: string; price: number; ends_at: string } | null;
  markdown: { price: number; pct: number | null; quantity: number; expiry_date: string | null; batch_code: string } | null;
  in_stock: boolean;
  stock_level: "in_stock" | "low_stock" | "out_of_stock";
  location: LocationView | null;
  image_url: string | null;
  tags: string[];
  is_perishable: boolean;
  score?: number | null;
  reason?: string | null;
  source?: string | null;
  quantity?: number | null;
  line_total?: number | null;
  slot?: string | null;
  visual_similarity?: number | null;
}

export interface ProductSearchResponse extends Page<ProductCard> {
  search: { query: string | null; method: string; embedding_model: string; embedding_kind: string };
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  product_count: number;
}

// ---------------------------------------------------------------- floor plan / routing

export interface Fixture {
  id: string;
  code: string;
  kind: string;
  label: string;
  aisle_code: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  levels: number;
  is_chilled: boolean;
  is_movable: boolean;
}

export interface Shelf {
  id: string;
  code: string;
  fixture_id: string;
  aisle_code: string | null;
  section: number;
  level: number;
  height_cm: number;
  x: number;
  y: number;
  capacity_facings: number;
  is_clearance: boolean;
  access_node: string | null;
  products: { placement_id: string; product_id: string; name: string; sku: string; facings: number; is_primary: boolean; category: string | null }[];
}

export interface NavNodeView {
  code: string;
  x: number;
  y: number;
  kind: string;
  label: string | null;
}

export interface Layout {
  id: string;
  store_id: string;
  name: string;
  version: number;
  status: "active" | "draft" | "archived";
  width_m: number;
  height_m: number;
  based_on_layout_id: string | null;
  published_at: string | null;
  fixtures: Fixture[];
  shelves: Shelf[];
  nodes: NavNodeView[];
  edges: { from: string; to: string; distance_m: number; accessible: boolean; blocked: boolean }[];
}

export interface RouteStep {
  type: "start" | "walk" | "turn" | "pick" | "finish";
  instruction: string;
  x: number;
  y: number;
  distance_m: number;
  stop_keys?: string[];
}

export interface RouteStop {
  order: number;
  node_code: string;
  x: number;
  y: number;
  items: { item_id: string; name: string; shelf_code: string | null; level: number | null; shelf_x: number | null; shelf_y: number | null }[];
}

export interface RouteResponse {
  list_id?: string | null;
  store_id: string;
  layout_id: string;
  list_version?: number | null;
  algorithm: string;
  total_distance_m: number;
  unoptimized_distance_m: number;
  saved_distance_m: number;
  stops: RouteStop[];
  path: { code: string; x: number; y: number }[];
  steps: RouteStep[];
  unrouted: { item_id?: string; product_id?: string; name: string; reason: string }[];
  accessible_only: boolean;
  positioning: string;
}

// ---------------------------------------------------------------- shopping lists

export interface Candidate {
  product_id: string;
  name: string;
  price: number;
  in_stock: boolean;
  score: number | null;
  location: string | null;
}

export interface ParsedItem {
  raw_text: string;
  quantity: number;
  unit: string | null;
  product_id: string | null;
  display_name: string;
  confidence: number;
  status: "pending" | "unavailable" | "unresolved";
  needs_review: boolean;
  candidates: Candidate[];
}

export interface ParseResponse {
  items: ParsedItem[];
  duplicates_merged: { raw_text: string; merged_into: string }[];
  unresolved: string[];
  parser: { provider: string; kind: string; fell_back: boolean };
}

export type ItemStatus = "pending" | "collected" | "unavailable" | "unresolved";

export interface ListItem {
  id: string;
  raw_text: string;
  display_name: string;
  product_id: string | null;
  quantity: number;
  unit: string | null;
  status: ItemStatus;
  match_confidence: number | null;
  candidates: Candidate[];
  position: number;
  version: number;
  collected_by_id: string | null;
  collected_at: string | null;
  updated_at: string | null;
  product: ProductCard | null;
}

export interface ShoppingListView {
  id: string;
  name: string;
  status: "active" | "completed" | "archived";
  is_shared: boolean;
  version: number;
  store: { id: string; name: string; code: string } | null;
  raw_input: string | null;
  items: ListItem[];
  groups: { key: string; label: string; order: string; item_ids: string[] }[];
  progress: { total: number; collected: number; unresolved: number; unavailable: number; percent: number };
  my_role: "owner" | "editor" | "viewer" | null;
  members: { user_id: string; name: string; role: string }[];
  updated_at: string;
}

export interface ListSummary {
  id: string;
  name: string;
  status: string;
  is_shared: boolean;
  store_id: string | null;
  store_name: string | null;
  item_count: number;
  collected_count: number;
  my_role: string;
  updated_at: string;
}

export interface InvitationCreated {
  id: string;
  role: string;
  expires_at: string;
  max_uses: number;
  use_count: number;
  revoked: boolean;
  created_at: string;
  token: string;
  url: string;
  qr_svg: string;
}

// ---------------------------------------------------------------- assistant / visual

export interface AssistantResponse {
  message: string;
  intent: { intent: string; search_queries: string[]; occasion: string | null; budget: number | null; people: number | null; reference_product: string | null };
  products: ProductCard[];
  complementary: ProductCard[];
  reference: ProductCard | null;
  basket: { total: number; budget: number | null; people: number | null; within_budget: boolean; skipped: string[]; occasion: string | null } | null;
  unmatched: string[];
  directions: (LocationView & { product_id: string; name: string })[];
  clarifying_question: string | null;
  provider: { name: string; kind: string; fell_back: boolean };
  grounding: { validated: boolean; issues: string[] };
}

export interface VisualSearchResponse {
  matches: ProductCard[];
  method: string;
  method_description: string;
  caption: string | null;
  image: { width: number; height: number };
}

// ---------------------------------------------------------------- notifications

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  data: Record<string, unknown>;
  channel: string;
  read: boolean;
  created_at: string;
}

export interface JobOut {
  id: string;
  job_type: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface MerchantStore {
  id: string;
  code: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  geofence_radius_m: number;
  timezone: string;
}
