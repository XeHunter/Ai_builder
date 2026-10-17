/** Observed sales vs forecast (mean + ~80% interval) with precipitation on a separate, x-synchronised panel. */
import * as React from "react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { axisProps, CHART_COLORS, gridProps, tooltipStyle } from "@/lib/chart";
import { formatDate } from "@/lib/utils";

import type { ProductSeries } from "./types";

export interface ChartRow {
  date: string;
  observed: number | null;
  forecast: number | null;
  band: [number, number] | null;
  precipitation: number | null;
}

/** Merge actuals and forecast into one date-indexed series; the two never share a value column. */
export function buildChartRows(series: ProductSeries): ChartRow[] {
  const rows = new Map<string, ChartRow>();
  for (const a of series.actual) {
    rows.set(a.date, { date: a.date, observed: a.units, forecast: null, band: null, precipitation: a.precipitation_mm });
  }
  for (const f of series.forecast) {
    const prev = rows.get(f.date);
    rows.set(f.date, {
      date: f.date,
      observed: prev?.observed ?? null,
      forecast: f.predicted,
      band: [f.lower, f.upper],
      precipitation: f.precipitation_mm ?? prev?.precipitation ?? null,
    });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const OBSERVED = CHART_COLORS[0];
const FORECAST = CHART_COLORS[1];
const RAIN = CHART_COLORS[4];
const tick = (d: string) => formatDate(d);

export function ForecastChart({ series }: { series: ProductSeries }) {
  const rows = React.useMemo(() => buildChartRows(series), [series]);
  const forecastStart = series.forecast[0]?.date;
  const syncId = React.useId();
  const totalFc = series.forecast.reduce((n, f) => n + f.predicted, 0);
  const avgObs = series.actual.length ? series.actual.reduce((n, a) => n + a.units, 0) / series.actual.length : 0;
  const summary = `${series.name}: ${series.actual.length} days of observed sales averaging ${avgObs.toFixed(1)} units per day, followed by a ${series.forecast.length}-day forecast totalling ${totalFc.toFixed(0)} units.`;

  return (
    <figure aria-label={summary}>
      <div className="h-72 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} syncId={syncId} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} tickFormatter={tick} minTickGap={24} />
            <YAxis {...axisProps} allowDecimals={false} width={44} />
            <Tooltip
              {...tooltipStyle}
              labelFormatter={(d) => formatDate(String(d), { weekday: "short" })}
              formatter={(value, name) => {
                if (Array.isArray(value)) return [`${Number(value[0]).toFixed(1)} – ${Number(value[1]).toFixed(1)}`, name];
                return [value == null ? "—" : Number(value).toFixed(1), name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Area type="monotone" dataKey="band" name="Forecast interval (~80%)" stroke="none" fill={FORECAST} fillOpacity={0.14} connectNulls={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="observed" name="Observed sales" stroke={OBSERVED} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="forecast" name="Forecast (mean)" stroke={FORECAST} strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls={false} isAnimationActive={false} />
            {forecastStart && <ReferenceLine x={forecastStart} stroke="#94a3b8" strokeDasharray="2 3" label={{ value: "Forecast starts", position: "insideTopLeft", fontSize: 11, fill: "#5f6b7a" }} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-3 text-xs font-medium text-muted-foreground">Precipitation (mm/day)</p>
      <div className="h-20 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} syncId={syncId} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis {...axisProps} width={44} />
            <Tooltip {...tooltipStyle} labelFormatter={(d) => formatDate(String(d), { weekday: "short" })} formatter={(v) => [v == null ? "—" : `${Number(v).toFixed(1)} mm`, "Precipitation"]} />
            {forecastStart && <ReferenceLine x={forecastStart} stroke="#94a3b8" strokeDasharray="2 3" />}
            <Bar dataKey="precipitation" name="Precipitation" fill={RAIN} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-primary">Show data table</summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Daily observed sales, forecast and precipitation</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1">Date</th>
                <th scope="col">Observed</th>
                <th scope="col">Forecast</th>
                <th scope="col">Interval</th>
                <th scope="col">Rain mm</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((r) => (
                <tr key={r.date} className="border-t border-border">
                  <th scope="row" className="py-1 text-left font-normal">{formatDate(r.date)}</th>
                  <td>{r.observed ?? "—"}</td>
                  <td>{r.forecast?.toFixed(1) ?? "—"}</td>
                  <td>{r.band ? `${r.band[0].toFixed(1)}–${r.band[1].toFixed(1)}` : "—"}</td>
                  <td>{r.precipitation?.toFixed(1) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
