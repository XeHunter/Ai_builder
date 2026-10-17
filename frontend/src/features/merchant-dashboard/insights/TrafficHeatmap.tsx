/** Day-of-week × hour traffic grid (sequential single-hue scale) with table semantics. */
import * as React from "react";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface TrafficCell {
  dow: number;
  hour: number;
  transactions: number;
}

/** Dense 7 × N grid covering the hours that have any traffic (zero-filled). */
export function buildTrafficGrid(cells: TrafficCell[]): { hours: number[]; grid: number[][]; max: number } {
  if (!cells.length) return { hours: [], grid: [], max: 0 };
  const minH = Math.min(...cells.map((c) => c.hour));
  const maxH = Math.max(...cells.map((c) => c.hour));
  const hours = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);
  const grid = DAYS.map(() => hours.map(() => 0));
  for (const c of cells) if (c.dow >= 0 && c.dow < 7) grid[c.dow][c.hour - minH] += c.transactions;
  return { hours, grid, max: Math.max(0, ...grid.flat()) };
}

const LIGHT = [231, 245, 243]; // primary-soft
const DARK = [15, 94, 89]; // deep teal

export function trafficColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return "#f6f7f9";
  const t = Math.sqrt(value / max); // sqrt keeps quiet hours distinguishable
  const c = LIGHT.map((v, i) => Math.round(v + (DARK[i] - v) * t));
  return `rgb(${c.join(",")})`;
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function TrafficHeatmap({ cells }: { cells: TrafficCell[] }) {
  const { hours, grid, max } = React.useMemo(() => buildTrafficGrid(cells), [cells]);
  const [active, setActive] = React.useState<string | null>(null);
  if (!hours.length) return <p className="text-sm text-muted-foreground">No sale transactions in this window.</p>;
  const peak = grid.flatMap((row, d) => row.map((v, h) => ({ v, d, h: hours[h] }))).sort((a, b) => b.v - a.v)[0];
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-[2px] text-[11px]">
          <caption className="sr-only">
            Sale transactions by day of week and hour (store local time). Peak: {DAYS[peak.d]} {hourLabel(peak.h)} with {peak.v} transactions.
          </caption>
          <thead>
            <tr>
              <td />
              {hours.map((h) => (
                <th key={h} scope="col" className="w-8 text-center font-normal text-muted-foreground">
                  {h % 2 === 0 ? h : <span className="sr-only">{h}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, d) => (
              <tr key={d}>
                <th scope="row" className="pr-2 text-right font-medium text-muted-foreground">{DAYS[d]}</th>
                {row.map((v, i) => {
                  const label = `${DAYS[d]} ${hourLabel(hours[i])}: ${v.toLocaleString("en-IN")} transactions`;
                  return (
                    <td
                      key={i}
                      tabIndex={0}
                      title={label}
                      aria-label={label}
                      onMouseEnter={() => setActive(label)}
                      onFocus={() => setActive(label)}
                      onMouseLeave={() => setActive(null)}
                      className="h-7 w-8 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-foreground"
                      style={{ background: trafficColor(v, max) }}
                    >
                      <span className="sr-only">{v}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite" className="min-h-4 text-foreground">{active ?? `Peak: ${DAYS[peak.d]} ${hourLabel(peak.h)} (${peak.v} transactions)`}</span>
        <span className="flex items-center gap-2">
          0
          <span className="h-2.5 w-28 rounded-sm" style={{ background: `linear-gradient(90deg, ${trafficColor(max * 0.01, max)}, ${trafficColor(max * 0.25, max)}, ${trafficColor(max, max)})` }} aria-hidden />
          {max.toLocaleString("en-IN")}
        </span>
      </div>
    </div>
  );
}
