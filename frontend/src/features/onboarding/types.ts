/** Types for the store-owner onboarding endpoints (backend/app/api/v1/onboarding.py, channels.py). */
import type { Layout } from "@/types/api";

export type StepKey = "store" | "layout" | "catalog" | "history" | "channels";

export interface OnboardingStore {
  id: string;
  code: string;
  name: string;
  city: string;
}

export interface OnboardingStatus {
  steps: Record<StepKey, boolean>;
  complete: boolean;
  stores: OnboardingStore[];
  counts: { products: number; stocked_items: number; sales: number; api_keys: number };
}

export interface LayoutSpec {
  aisles: number;
  sections: number;
  levels: number;
  checkouts: number;
  dairy_wall: boolean;
  produce_wall: boolean;
  frozen_wall: boolean;
}

export interface LayoutPreview extends Layout {
  stats: { width_m: number; height_m: number; area_m2: number; shelf_locations: number; walk_nodes: number; aisles: number; checkouts: number };
}

export interface LayoutGenerateResult {
  layout_id: string;
  status: "active" | "draft";
  version: number;
}

export interface SalesHistoryResult {
  rows: number;
  receipts_imported: number;
  lines_imported: number;
  duplicate_receipts_skipped: number;
  error_rows: number;
  errors: { row: number; message: string }[];
}

export interface ApiKeyCreated {
  id: string;
  name: string;
  channel: string;
  provider: string;
  prefix: string;
  store_id: string | null;
  store_code: string | null;
  created_at: string;
  secret: string;
}

export interface FinishResult {
  images_generated: number;
  jobs: Record<string, { id: string; status: string }>;
  status: OnboardingStatus;
}
