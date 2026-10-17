/**
 * Diverging colour scale for lift, centred on 1 (independence) in log2 space.
 * Below 1 → warm (orange), ≈ 1 → neutral grey, above 1 → teal. Null → muted (insufficient co-purchases).
 */

export type LiftBucket = "none" | "below" | "neutral" | "above";

const NEUTRAL = [241, 243, 246]; // #f1f3f6
const LOW = [194, 65, 12]; // #c2410c  (orange-700)
const HIGH = [15, 118, 110]; // #0f766e (primary teal)
export const NULL_COLOR = "#fbfcfd";

/** Lifts within ±NEUTRAL_BAND of 1 are treated as "about independent". */
export const NEUTRAL_BAND = 0.1;

export function liftBucket(lift: number | null | undefined): LiftBucket {
  if (lift === null || lift === undefined || !Number.isFinite(lift)) return "none";
  if (Math.abs(lift - 1) <= NEUTRAL_BAND) return "neutral";
  return lift < 1 ? "below" : "above";
}

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Signed intensity in [-1, 1]; ±1 reached at lift = 1/maxLift or maxLift (default 4). */
export function liftIntensity(lift: number, maxLift = 4): number {
  if (lift <= 0) return -1;
  const t = Math.log2(lift) / Math.log2(maxLift);
  return Math.max(-1, Math.min(1, t));
}

export function liftColor(lift: number | null | undefined, maxLift = 4): { bg: string; fg: string; bucket: LiftBucket } {
  const bucket = liftBucket(lift);
  if (bucket === "none") return { bg: NULL_COLOR, fg: "#94a3b8", bucket };
  if (bucket === "neutral") return { bg: mix(NEUTRAL, NEUTRAL, 0), fg: "#111827", bucket };
  const t = liftIntensity(lift as number, maxLift);
  const strength = Math.abs(t);
  const bg = mix(NEUTRAL, t < 0 ? LOW : HIGH, 0.15 + 0.85 * strength);
  return { bg, fg: strength > 0.5 ? "#ffffff" : "#111827", bucket };
}
