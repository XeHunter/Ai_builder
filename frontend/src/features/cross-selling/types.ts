/** Types for /merchant/affinity (backend/app/api/v1/cross_selling.py). */

export interface AffinityRun {
  id: string;
  store_id: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
  window_days: number;
  min_support: number;
  min_confidence: number;
  min_pair_count: number;
  transactions_analyzed: number | null;
  rules_found: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  job_id?: string;
}

export interface AffinityRule {
  antecedent_id: string;
  antecedent: string;
  consequent_id: string;
  consequent: string;
  pair_count: number;
  support: number;
  confidence: number;
  lift: number;
  antecedent_support: number;
  consequent_support: number;
}

export interface AffinityRunDetail extends AffinityRun {
  rules: AffinityRule[];
  interpretation: string;
}

export interface Heatmap {
  categories: string[];
  lift: (number | null)[][];
  pair_counts: number[][];
}

export interface AffinityGraph {
  nodes: { id: string; name: string; category: string | null }[];
  edges: { source: string; target: string; lift: number; pair_count: number; confidence: number }[];
}
