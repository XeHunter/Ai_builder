/** Shared chart styling so every Recharts visualisation looks consistent. */
export const CHART_COLORS = ["#0f766e", "#4f46e5", "#d97706", "#db2777", "#0891b2", "#65a30d", "#7c3aed"];

export const axisProps = {
  stroke: "#94a3b8",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

export const gridProps = { stroke: "#e3e7ed", strokeDasharray: "3 3", vertical: false } as const;

export const tooltipStyle = {
  contentStyle: { borderRadius: 8, border: "1px solid #e3e7ed", fontSize: 12, boxShadow: "0 8px 24px -12px rgb(16 24 40 / .25)" },
  labelStyle: { fontWeight: 600, color: "#111827" },
} as const;
