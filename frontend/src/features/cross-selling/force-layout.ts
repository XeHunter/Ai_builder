/**
 * Small deterministic force-directed layout (Fruchterman–Reingold) for the product affinity network.
 * Same input + seed → same positions, so the graph doesn't jump between renders.
 */

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
  /** Relative attraction strength (e.g. normalised lift); defaults to 1. */
  weight?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ForceOptions {
  width: number;
  height: number;
  iterations?: number;
  seed?: number;
  padding?: number;
}

/** mulberry32 PRNG: tiny, fast and deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function forceLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts: ForceOptions): Map<string, Point> {
  const { width, height, iterations = 300, seed = 42, padding = 24 } = opts;
  const out = new Map<string, Point>();
  const n = nodes.length;
  if (!n) return out;
  const minX = padding;
  const minY = padding;
  const maxX = Math.max(padding, width - padding);
  const maxY = Math.max(padding, height - padding);
  const rand = seededRandom(seed);
  // sort for order-independence
  const ids = nodes.map((x) => x.id).sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const pos = ids.map(() => ({ x: minX + rand() * (maxX - minX), y: minY + rand() * (maxY - minY) }));
  if (n === 1) {
    out.set(ids[0], { x: width / 2, y: height / 2 });
    return out;
  }
  const links = edges
    .map((e) => ({ s: index.get(e.source), t: index.get(e.target), w: e.weight ?? 1 }))
    .filter((l): l is { s: number; t: number; w: number } => l.s !== undefined && l.t !== undefined && l.s !== l.t);
  const area = (maxX - minX) * (maxY - minY);
  const k = Math.sqrt(area / n) * 0.5;
  let temp = Math.max(maxX - minX, maxY - minY) / 8;
  const cool = temp / (iterations + 1);
  const disp = pos.map(() => ({ x: 0, y: 0 }));

  for (let it = 0; it < iterations; it++) {
    for (const d of disp) d.x = d.y = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          // deterministic nudge for coincident points
          dx = (i - j) * 0.01;
          dy = 0.01;
          dist = Math.hypot(dx, dy);
        }
        const f = (k * k) / dist;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        disp[i].x += fx;
        disp[i].y += fy;
        disp[j].x -= fx;
        disp[j].y -= fy;
      }
    }
    for (const l of links) {
      const dx = pos[l.s].x - pos[l.t].x;
      const dy = pos[l.s].y - pos[l.t].y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const f = ((dist * dist) / k) * Math.min(Math.max(l.w, 0.2), 3);
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      disp[l.s].x -= fx;
      disp[l.s].y -= fy;
      disp[l.t].x += fx;
      disp[l.t].y += fy;
    }
    // gravity keeps disconnected components together near the centre
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (let i = 0; i < n; i++) {
      disp[i].x += (cx - pos[i].x) * 1;
      disp[i].y += (cy - pos[i].y) * 1;
      const d = Math.max(Math.hypot(disp[i].x, disp[i].y), 0.01);
      const step = Math.min(d, temp);
      pos[i].x = Math.min(maxX, Math.max(minX, pos[i].x + (disp[i].x / d) * step));
      pos[i].y = Math.min(maxY, Math.max(minY, pos[i].y + (disp[i].y / d) * step));
    }
    temp = Math.max(temp - cool, 0.5);
  }
  // stretch the result to use the available area (gravity leaves a margin)
  const bx = [Math.min(...pos.map((p) => p.x)), Math.max(...pos.map((p) => p.x))];
  const by = [Math.min(...pos.map((p) => p.y)), Math.max(...pos.map((p) => p.y))];
  const fit = (v: number, [lo, hi]: number[], a: number, b: number) => (hi - lo < 1e-6 ? (a + b) / 2 : a + ((v - lo) / (hi - lo)) * (b - a));
  ids.forEach((id, i) =>
    out.set(id, { x: Math.round(fit(pos[i].x, bx, minX, maxX) * 10) / 10, y: Math.round(fit(pos[i].y, by, minY, maxY) * 10) / 10 }),
  );
  return out;
}
