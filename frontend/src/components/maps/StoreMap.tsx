/**
 * Interactive SVG floor plan.
 *
 * Renders fixtures, walkways (graph edges), shelf sections, an optional route with numbered stops,
 * highlighted shelves, a start marker, and supports:
 *  - clicking a shelf section (onShelfClick) — keyboard accessible;
 *  - clicking the floor to choose a start point (onFloorClick);
 *  - dropping a dragged item onto a shelf (onShelfDrop, HTML5 drag-and-drop, data key "text/plain");
 *  - dragging movable fixtures (onFixtureMove, pointer events) in edit mode.
 * Coordinates are metres (x right, y down), matching the backend layout model.
 */
import * as React from "react";

import { cn } from "@/lib/utils";
import type { Fixture, Layout, RouteResponse, Shelf } from "@/types/api";

const FIXTURE_STYLE: Record<string, { fill: string; stroke: string }> = {
  aisle_shelf: { fill: "#e8edf3", stroke: "#b9c4d1" },
  wall_shelf: { fill: "#eaf3e6", stroke: "#b5cfa9" },
  chiller: { fill: "#e0f2fe", stroke: "#7dd3fc" },
  freezer: { fill: "#e0e7ff", stroke: "#a5b4fc" },
  endcap: { fill: "#fef3c7", stroke: "#fbbf24" },
  display: { fill: "#fce7f3", stroke: "#f9a8d4" },
  clearance: { fill: "#fee2e2", stroke: "#f87171" },
  checkout: { fill: "#ede9fe", stroke: "#a78bfa" },
  entrance: { fill: "#dcfce7", stroke: "#4ade80" },
  exit: { fill: "#fee2e2", stroke: "#f87171" },
};

/** One clickable marker per shelf *section* (levels at the same x/y are grouped). */
export interface ShelfSection {
  key: string;
  x: number;
  y: number;
  shelves: Shelf[];
  label: string;
}

export function groupShelves(shelves: Shelf[]): ShelfSection[] {
  const map = new Map<string, ShelfSection>();
  for (const s of shelves) {
    const key = `${s.fixture_id}:${s.x.toFixed(2)}:${s.y.toFixed(2)}`;
    const g = map.get(key) ?? { key, x: s.x, y: s.y, shelves: [], label: s.code.replace(/-\d+$/, "") };
    g.shelves.push(s);
    map.set(key, g);
  }
  for (const g of map.values()) g.shelves.sort((a, b) => b.level - a.level);
  return [...map.values()];
}

export interface StoreMapProps {
  layout: Layout;
  route?: RouteResponse | null;
  /** Shelf codes (full codes, e.g. "A3-L-2-4") to highlight. */
  highlight?: string[];
  /** Section key or shelf code currently selected. */
  selectedShelfCode?: string | null;
  start?: { x: number; y: number } | null;
  onFloorClick?: (point: { x: number; y: number }) => void;
  onSectionClick?: (section: ShelfSection) => void;
  onShelfDrop?: (section: ShelfSection, data: string) => void;
  onFixtureMove?: (fixture: Fixture, to: { x: number; y: number }) => void;
  editable?: boolean;
  showWalkways?: boolean;
  /** Highlight route progress: stop orders that are complete. */
  completedStops?: number[];
  className?: string;
  ariaLabel?: string;
}

const SCALE = 20; // px per metre in the SVG coordinate system

export function StoreMap({
  layout,
  route,
  highlight = [],
  selectedShelfCode,
  start,
  onFloorClick,
  onSectionClick,
  onShelfDrop,
  onFixtureMove,
  editable,
  showWalkways = true,
  completedStops = [],
  className,
  ariaLabel = "Store floor plan",
}: StoreMapProps) {
  const svgRef = React.useRef<SVGSVGElement>(null);
  const sections = React.useMemo(() => groupShelves(layout.shelves), [layout.shelves]);
  const nodeByCode = React.useMemo(() => new Map(layout.nodes.map((n) => [n.code, n])), [layout.nodes]);
  const highlightSet = React.useMemo(() => new Set(highlight), [highlight]);
  const [drag, setDrag] = React.useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);
  const [dropKey, setDropKey] = React.useState<string | null>(null);

  const toMetres = (evt: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const m = svg.getScreenCTM();
    const p = m ? pt.matrixTransform(m.inverse()) : pt;
    return { x: p.x / SCALE, y: p.y / SCALE };
  };

  const routePoints = route?.path.map((p) => `${p.x * SCALE},${p.y * SCALE}`).join(" ");
  const W = layout.width_m * SCALE;
  const H = layout.height_m * SCALE;

  return (
    <div className={cn("relative w-full overflow-hidden rounded-lg border border-border bg-surface", className)}>
      <svg
        ref={svgRef}
        viewBox={`-10 -10 ${W + 20} ${H + 20}`}
        className="h-auto w-full select-none"
        role="img"
        aria-label={ariaLabel}
        onClick={(e) => {
          if (onFloorClick && (e.target as Element).getAttribute("data-floor") === "1") onFloorClick(toMetres(e));
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = toMetres(e);
          setDrag({ ...drag, x: p.x - drag.dx, y: p.y - drag.dy });
        }}
        onPointerUp={() => {
          if (drag && onFixtureMove) {
            const f = layout.fixtures.find((fx) => fx.id === drag.id);
            if (f) onFixtureMove(f, { x: Math.round(drag.x * 10) / 10, y: Math.round(drag.y * 10) / 10 });
          }
          setDrag(null);
        }}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-primary)" />
          </marker>
        </defs>
        <rect x={0} y={0} width={W} height={H} rx={8} fill="#fbfcfd" stroke="#cfd6df" data-floor="1"
          className={onFloorClick ? "cursor-crosshair" : undefined} />

        {showWalkways &&
          layout.edges.map((e, i) => {
            const a = nodeByCode.get(e.from);
            const b = nodeByCode.get(e.to);
            if (!a || !b) return null;
            return (
              <line key={i} x1={a.x * SCALE} y1={a.y * SCALE} x2={b.x * SCALE} y2={b.y * SCALE}
                stroke={e.blocked ? "#fca5a5" : "#e3e7ed"} strokeWidth={e.accessible ? 10 : 6} strokeLinecap="round" pointerEvents="none" />
            );
          })}

        {layout.fixtures.map((f) => {
          const st = FIXTURE_STYLE[f.kind] ?? FIXTURE_STYLE.aisle_shelf;
          const isDragging = drag?.id === f.id;
          const x = isDragging ? drag.x : f.x;
          const y = isDragging ? drag.y : f.y;
          const canDrag = editable && f.is_movable && !!onFixtureMove;
          return (
            <g key={f.id}>
              <rect
                x={x * SCALE} y={y * SCALE} width={f.width * SCALE} height={f.height * SCALE} rx={3}
                fill={st.fill} stroke={canDrag ? "var(--color-accent)" : st.stroke} strokeWidth={canDrag ? 2 : 1}
                strokeDasharray={canDrag ? "4 3" : undefined} opacity={isDragging ? 0.75 : 1}
                className={canDrag ? "cursor-move" : undefined}
                onPointerDown={(e) => {
                  if (!canDrag) return;
                  const p = toMetres(e);
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setDrag({ id: f.id, dx: p.x - f.x, dy: p.y - f.y, x: f.x, y: f.y });
                }}
              >
                <title>{`${f.label}${canDrag ? " (drag to move)" : ""}`}</title>
              </rect>
              {(f.width >= 2.2 || f.height >= 2.2) && (
                <text
                  x={(x + f.width / 2) * SCALE} y={(y + f.height / 2) * SCALE}
                  fontSize={f.height > f.width ? 9 : 10} fill="#5f6b7a" textAnchor="middle" dominantBaseline="middle"
                  transform={f.height > f.width * 3 ? `rotate(-90 ${(x + f.width / 2) * SCALE} ${(y + f.height / 2) * SCALE})` : undefined}
                  pointerEvents="none"
                >
                  {f.label}
                </text>
              )}
            </g>
          );
        })}

        {sections.map((s) => {
          const isHi = s.shelves.some((sh) => highlightSet.has(sh.code));
          const isSel = !!selectedShelfCode && s.shelves.some((sh) => sh.code === selectedShelfCode || s.key === selectedShelfCode);
          const filled = s.shelves.some((sh) => sh.products.length > 0);
          const interactive = !!onSectionClick || !!onShelfDrop;
          const isDrop = dropKey === s.key;
          return (
            <g
              key={s.key}
              tabIndex={onSectionClick ? 0 : undefined}
              role={onSectionClick ? "button" : undefined}
              aria-label={onSectionClick ? `Shelf section ${s.label}` : undefined}
              onClick={(e) => {
                e.stopPropagation();
                onSectionClick?.(s);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSectionClick?.(s);
                }
              }}
              onDragOver={(e) => {
                if (!onShelfDrop) return;
                e.preventDefault();
                setDropKey(s.key);
              }}
              onDragLeave={() => setDropKey((k) => (k === s.key ? null : k))}
              onDrop={(e) => {
                if (!onShelfDrop) return;
                e.preventDefault();
                setDropKey(null);
                onShelfDrop(s, e.dataTransfer.getData("text/plain"));
              }}
              className={interactive ? "cursor-pointer outline-none" : undefined}
            >
              <circle
                cx={s.x * SCALE} cy={s.y * SCALE} r={isHi || isSel || isDrop ? 7 : interactive ? 4.5 : 3}
                fill={isSel ? "var(--color-accent)" : isHi ? "var(--color-warning)" : filled ? "#94a3b8" : "#d6dde6"}
                stroke={isDrop ? "var(--color-accent)" : isHi || isSel ? "#fff" : "none"} strokeWidth={2}
              />
              {interactive && <circle cx={s.x * SCALE} cy={s.y * SCALE} r={11} fill="transparent" />}
              <title>
                {`${s.label}\n` + s.shelves.map((sh) => `L${sh.level} (${sh.height_cm} cm): ${sh.products.map((p) => p.name).join(", ") || "empty"}`).join("\n")}
              </title>
            </g>
          );
        })}

        {routePoints && (
          <polyline points={routePoints} fill="none" stroke="var(--color-primary)" strokeWidth={4} strokeLinejoin="round"
            strokeLinecap="round" strokeDasharray="10 6" markerEnd="url(#arrow)" pointerEvents="none">
            <animate attributeName="stroke-dashoffset" from="32" to="0" dur="1.2s" repeatCount="indefinite" />
          </polyline>
        )}
        {route?.stops.map((s) => {
          const done = completedStops.includes(s.order);
          return (
            <g key={s.order} pointerEvents="none">
              <circle cx={s.x * SCALE} cy={s.y * SCALE} r={10} fill={done ? "var(--color-success)" : "var(--color-primary)"} stroke="#fff" strokeWidth={2} />
              <text x={s.x * SCALE} y={s.y * SCALE + 0.5} fontSize={10} fontWeight={700} fill="#fff" textAnchor="middle" dominantBaseline="middle">
                {s.order}
              </text>
            </g>
          );
        })}
        {layout.nodes.filter((n) => ["entrance", "exit", "checkout"].includes(n.kind)).map((n) => (
          <text key={n.code} x={n.x * SCALE} y={n.y * SCALE + 18} fontSize={10} fontWeight={600} fill="#334155" textAnchor="middle" pointerEvents="none">
            {n.kind === "entrance" ? "Entrance" : n.kind === "exit" ? "Exit" : "Checkout"}
          </text>
        ))}
        {start && (
          <g pointerEvents="none">
            <circle cx={start.x * SCALE} cy={start.y * SCALE} r={8} fill="var(--color-accent)" stroke="#fff" strokeWidth={3} />
            <text x={start.x * SCALE} y={start.y * SCALE - 13} fontSize={10} fontWeight={600} fill="var(--color-accent)" textAnchor="middle">
              You
            </text>
          </g>
        )}
      </svg>
      <div className="flex flex-wrap gap-3 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <Legend color="#e8edf3" label="Aisle shelving" />
        <Legend color="#e0f2fe" label="Chilled" />
        <Legend color="#fef3c7" label="Endcap" />
        <Legend color="#fee2e2" label="Clearance" />
        {route && <Legend color="var(--color-primary)" label="Your route" />}
        {highlight.length > 0 && <Legend color="var(--color-warning)" label="Highlighted shelf" />}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm border border-black/10" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}
