/** Product affinity network: deterministic force layout in SVG, node colour = category, edge width = lift. */
import * as React from "react";

import { CHART_COLORS } from "@/lib/chart";

import { forceLayout } from "./force-layout";
import type { AffinityGraph } from "./types";

const W = 760;
const H = 500;
const OTHER = "#94a3b8";

/** Fixed category → colour assignment: the most frequent categories get palette slots, the rest fold into "Other". */
export function categoryColors(nodes: AffinityGraph["nodes"]): { map: Map<string, string>; legend: { label: string; color: string }[] } {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.category ?? "Uncategorised", (counts.get(n.category ?? "Uncategorised") ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const map = new Map<string, string>();
  const slots = CHART_COLORS.length;
  ranked.forEach(([c], i) => map.set(c, i < slots ? CHART_COLORS[i] : OTHER));
  const legend = ranked.slice(0, slots).map(([c]) => ({ label: c, color: map.get(c)! }));
  if (ranked.length > slots) legend.push({ label: `Other (${ranked.length - slots} categories)`, color: OTHER });
  return { map, legend };
}

export function AffinityNetwork({ graph }: { graph: AffinityGraph }) {
  const [hover, setHover] = React.useState<string | null>(null);
  const maxLift = Math.max(2, ...graph.edges.map((e) => e.lift));
  const positions = React.useMemo(
    () =>
      forceLayout(
        graph.nodes,
        graph.edges.map((e) => ({ source: e.source, target: e.target, weight: 0.5 + Math.log(e.lift) / Math.log(maxLift) })),
        { width: W, height: H, iterations: 300, seed: 7, padding: 40 },
      ),
    [graph, maxLift],
  );
  const { map: colorOf, legend } = React.useMemo(() => categoryColors(graph.nodes), [graph.nodes]);
  const degree = React.useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph.edges) {
      d.set(e.source, (d.get(e.source) ?? 0) + 1);
      d.set(e.target, (d.get(e.target) ?? 0) + 1);
    }
    return d;
  }, [graph.edges]);
  // label one hub per connected component by default (the rest on hover) to avoid label pile-ups
  const hubs = React.useMemo(() => {
    const parent = new Map(graph.nodes.map((n) => [n.id, n.id]));
    const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
    for (const e of graph.edges) parent.set(find(e.source), find(e.target));
    const best = new Map<string, string>();
    for (const n of graph.nodes) {
      const root = find(n.id);
      const cur = best.get(root);
      if (!cur || (degree.get(n.id) ?? 0) > (degree.get(cur) ?? 0)) best.set(root, n.id);
    }
    return new Set(best.values());
  }, [graph, degree]);
  const neighbours = React.useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const e of graph.edges) {
      if (e.source === hover) s.add(e.target);
      if (e.target === hover) s.add(e.source);
    }
    return s;
  }, [hover, graph.edges]);
  const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const width = (lift: number) => 1 + 5 * Math.min(1, Math.log(lift) / Math.log(maxLift));
  const hovered = hover ? graph.nodes.find((n) => n.id === hover) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="group" aria-label={`Product affinity network with ${graph.nodes.length} products and ${graph.edges.length} links`}>
          {graph.edges.map((e, i) => {
            const a = positions.get(e.source);
            const b = positions.get(e.target);
            if (!a || !b) return null;
            const on = !neighbours || (neighbours.has(e.source) && neighbours.has(e.target) && (e.source === hover || e.target === hover));
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on && hover ? "#334155" : "#94a3b8"} strokeOpacity={on ? 0.7 : 0.08}
                strokeWidth={width(e.lift)} strokeLinecap="round">
                <title>{`${names.get(e.source)} ↔ ${names.get(e.target)}: lift ${e.lift.toFixed(2)}, ${e.pair_count} baskets`}</title>
              </line>
            );
          })}
          {graph.nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const dim = neighbours && !neighbours.has(n.id);
            const deg = degree.get(n.id) ?? 0;
            const r = 5 + Math.min(deg, 6) * 1.2;
            const showLabel = neighbours ? neighbours.has(n.id) : hubs.has(n.id);
            const label = n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name;
            return (
              <g
                key={n.id}
                tabIndex={0}
                role="button"
                aria-label={`${n.name} (${n.category ?? "uncategorised"}), ${deg} link${deg === 1 ? "" : "s"}`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                opacity={dim ? 0.2 : 1}
                className="cursor-pointer outline-none"
              >
                <circle cx={p.x} cy={p.y} r={r} fill={colorOf.get(n.category ?? "Uncategorised") ?? OTHER} stroke="#fff" strokeWidth={2} />
                {hover === n.id && <circle cx={p.x} cy={p.y} r={r + 4} fill="none" stroke="#111827" strokeWidth={1.5} />}
                {showLabel && (
                  <text x={p.x} y={p.y - r - 5} textAnchor="middle" fontSize={10.5} fill="#1f2937" stroke="#fbfcfd" strokeWidth={3} paintOrder="stroke" pointerEvents="none">
                    {label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="min-h-5 text-sm" aria-live="polite">
        {hovered ? (
          <>
            <span className="font-medium">{hovered.name}</span> · {hovered.category ?? "Uncategorised"} · linked to{" "}
            {graph.edges.filter((e) => e.source === hovered.id || e.target === hovered.id).map((e) => `${names.get(e.source === hovered.id ? e.target : e.source)} (lift ${e.lift.toFixed(1)})`).join(", ")}
          </>
        ) : (
          <span className="text-muted-foreground">Hover or tab to a product to highlight its links. Thicker lines = higher lift.</span>
        )}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Category colours">
        {legend.map((l) => (
          <li key={l.label} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: l.color }} aria-hidden /> {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
