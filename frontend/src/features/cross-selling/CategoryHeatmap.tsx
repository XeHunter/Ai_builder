/** Category × category lift matrix as an accessible table with a diverging colour scale centred on lift = 1. */
import * as React from "react";

import { liftColor, NULL_COLOR } from "./heat-scale";
import type { Heatmap } from "./types";

export function CategoryHeatmap({ data }: { data: Heatmap }) {
  const [active, setActive] = React.useState<{ i: number; j: number } | null>(null);
  const cats = data.categories;
  const describe = (i: number, j: number) => {
    const lift = data.lift[i]?.[j];
    if (i === j) return `${cats[i]}: same category (not computed)`;
    if (lift == null) return `${cats[i]} × ${cats[j]}: not enough co-purchases`;
    return `${cats[i]} × ${cats[j]}: lift ${lift.toFixed(2)}, ${data.pair_counts[i][j].toLocaleString("en-IN")} baskets with both`;
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto pr-24">
        <table className="border-separate border-spacing-[2px] text-[11px]" aria-label="Category affinity heatmap (lift)">
          <thead>
            <tr>
              <td />
              {cats.map((c, j) => (
                <th key={c} scope="col" className="relative h-28 w-9 min-w-9 max-w-9 p-0 align-bottom font-medium text-muted-foreground">
                  <span className={`absolute bottom-1 left-1/2 block w-32 origin-bottom-left -rotate-45 truncate whitespace-nowrap text-left ${active?.j === j ? "text-foreground" : ""}`}>{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map((row, i) => (
              <tr key={row}>
                <th scope="row" className={`whitespace-nowrap pr-2 text-right font-medium ${active?.i === i ? "text-foreground" : "text-muted-foreground"}`}>
                  {row}
                </th>
                {cats.map((col, j) => {
                  const lift = i === j ? null : data.lift[i]?.[j];
                  const c = liftColor(lift);
                  const isActive = active?.i === i && active?.j === j;
                  return (
                    <td
                      key={col}
                      tabIndex={0}
                      aria-label={describe(i, j)}
                      title={describe(i, j)}
                      onMouseEnter={() => setActive({ i, j })}
                      onFocus={() => setActive({ i, j })}
                      onMouseLeave={() => setActive(null)}
                      className={`tabular h-9 w-9 min-w-9 max-w-9 rounded-[3px] text-center outline-none ${isActive ? "ring-2 ring-foreground" : ""} ${i === j ? "bg-[repeating-linear-gradient(45deg,#f1f3f6_0_3px,#fff_3px_6px)]" : ""}`}
                      style={i === j ? undefined : { background: c.bg, color: c.fg }}
                      data-bucket={i === j ? "diagonal" : c.bucket}
                    >
                      {lift == null ? "" : lift >= 10 ? lift.toFixed(0) : lift.toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="min-h-5 text-sm" aria-live="polite">
        {active ? describe(active.i, active.j) : <span className="text-muted-foreground">Hover or focus a cell for details.</span>}
      </p>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>Lift 0.25</span>
          <span className="h-3 w-40 rounded-sm" style={{ background: `linear-gradient(90deg, ${liftColor(0.25).bg}, ${liftColor(0.6).bg}, ${liftColor(1).bg}, ${liftColor(1.7).bg}, ${liftColor(4).bg})` }} aria-hidden />
          <span>4+</span>
        </span>
        <span>Grey ≈ 1 (independent) · orange = bought together less often · teal = more often</span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-border" style={{ background: NULL_COLOR }} aria-hidden /> Not enough co-purchases
        </span>
      </div>
    </div>
  );
}
