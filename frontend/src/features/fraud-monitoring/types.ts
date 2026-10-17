/** Types for /merchant/fraud (backend/app/api/v1/fraud.py). */

export interface Signal {
  code: string;
  name: string;
  weight: number;
  detail: string;
  value: number;
  kind: string;
}

export type AlertStatus = "open" | "in_review" | "escalated" | "closed";
export type Outcome = "confirmed_fraud" | "false_positive" | "inconclusive";

export interface FraudAlert {
  id: string;
  store_id: string | null;
  subject_type: "transaction" | "inventory" | string;
  subject_ref: string;
  transaction_id: string | null;
  rule_score: number;
  anomaly_score: number | null;
  risk_score: number;
  risk_level: "high" | "medium" | "low";
  signals: Signal[];
  summary: string;
  status: AlertStatus;
  outcome: Outcome | null;
  detected_at: string;
}

export interface TxnItem {
  product: string | null;
  quantity: number;
  detected_quantity: number | null;
  unit_price: number;
  line_total: number;
}

export interface Txn {
  id: string;
  receipt_number: string;
  type: "sale" | "return";
  channel: string;
  occurred_at: string;
  total: number;
  terminal_id: string | null;
  is_simulated: boolean;
  items: TxnItem[];
}

export interface AlertDetail extends FraudAlert {
  transaction?: Txn;
  original_transaction?: Txn | null;
  customer_history?: Record<string, { count: number; value: number }>;
  customer_ref?: string;
  investigation: {
    id: string;
    status: string;
    outcome: Outcome | null;
    closed_at: string | null;
    notes: { author: string; note: string; created_at: string }[];
  } | null;
  guidance: string;
}

export interface Evaluation {
  labelled_transactions: number;
  label_source: string | null;
  alerts: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number | null;
  recall: number | null;
  reviewed_alerts: number;
  reviewer_confirmed_rate: number | null;
  note: string;
}

export interface FraudRule {
  id: string;
  code: string;
  name: string;
  description: string;
  weight: number;
  params: Record<string, number>;
  is_active: boolean;
}

export interface IngestResult {
  transaction_id: string;
  receipt_number: string;
  scan: { transactions_scored: number; alerts_created: number; alerts_updated: number; threshold: number };
  alert: FraudAlert | null;
}
