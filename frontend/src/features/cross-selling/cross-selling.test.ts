import { describe, expect, it } from "vitest";

import { forceLayout } from "./force-layout";
import { liftBucket, liftColor, liftIntensity } from "./heat-scale";
import { sortRules } from "./CrossSellingPage";
import type { AffinityRule } from "./types";

const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
const edges = [
  { source: "n0", target: "n1", weight: 2 },
  { source: "n1", target: "n2" },
  { source: "n2", target: "n3" },
  { source: "n4", target: "n5", weight: 3 },
  { source: "n6", target: "n7" },
  { source: "n0", target: "n7" },
];

describe("forceLayout", () => {
  it("is deterministic for the same input and seed (and independent of node order)", () => {
    const a = forceLayout(nodes, edges, { width: 600, height: 400, seed: 7 });
    const b = forceLayout([...nodes].reverse(), edges, { width: 600, height: 400, seed: 7 });
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    const c = forceLayout(nodes, edges, { width: 600, height: 400, seed: 8 });
    expect([...c.values()]).not.toEqual([...a.values()]);
  });

  it("keeps every node inside the padded bounds", () => {
    const pos = forceLayout(nodes, edges, { width: 300, height: 200, padding: 20, iterations: 300 });
    expect(pos.size).toBe(nodes.length);
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(280);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(180);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  it("pulls linked nodes closer than unlinked ones on average", () => {
    const pos = forceLayout(nodes, edges, { width: 600, height: 400 });
    const d = (a: string, b: string) => Math.hypot(pos.get(a)!.x - pos.get(b)!.x, pos.get(a)!.y - pos.get(b)!.y);
    const linked = edges.map((e) => d(e.source, e.target));
    const unlinked = [d("n3", "n9"), d("n5", "n10"), d("n8", "n11"), d("n2", "n6")];
    const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
    expect(mean(linked)).toBeLessThan(mean(unlinked));
  });

  it("handles empty and single-node graphs", () => {
    expect(forceLayout([], [], { width: 100, height: 100 }).size).toBe(0);
    expect(forceLayout([{ id: "x" }], [], { width: 100, height: 80 }).get("x")).toEqual({ x: 50, y: 40 });
  });
});

describe("lift colour scale", () => {
  it("buckets lift around 1 and treats null as missing", () => {
    expect(liftBucket(null)).toBe("none");
    expect(liftBucket(0.4)).toBe("below");
    expect(liftBucket(1.04)).toBe("neutral");
    expect(liftBucket(0.95)).toBe("neutral");
    expect(liftBucket(2.5)).toBe("above");
  });

  it("is diverging and symmetric in log space", () => {
    expect(liftIntensity(1)).toBe(0);
    expect(liftIntensity(2)).toBeCloseTo(-liftIntensity(0.5));
    expect(liftIntensity(100)).toBe(1);
    expect(liftIntensity(0.01)).toBe(-1);
  });

  it("maps below 1 to warm, ≈1 to neutral grey and above 1 to teal", () => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r1, , b1] = rgb(liftColor(0.3).bg);
    const [r2, g2, b2] = rgb(liftColor(1).bg);
    const [r3, g3] = rgb(liftColor(4).bg);
    expect(r1).toBeGreaterThan(b1); // warm
    expect(Math.max(r2, g2, b2) - Math.min(r2, g2, b2)).toBeLessThan(8); // grey
    expect(g3).toBeGreaterThan(r3); // teal
    expect(liftColor(null).bucket).toBe("none");
    expect(liftColor(4).fg).toBe("#ffffff");
  });
});

describe("sortRules", () => {
  const r = (a: string, lift: number, pairs: number): AffinityRule => ({
    antecedent_id: a, antecedent: a, consequent_id: "c", consequent: "c", pair_count: pairs, support: pairs / 1000,
    confidence: 0.2, lift, antecedent_support: 0.1, consequent_support: 0.1,
  });
  it("sorts by the chosen column and direction", () => {
    const rules = [r("a", 2, 50), r("b", 5, 20), r("c", 1.2, 90)];
    expect(sortRules(rules, "lift", "desc").map((x) => x.antecedent)).toEqual(["b", "a", "c"]);
    expect(sortRules(rules, "pair_count", "asc").map((x) => x.antecedent)).toEqual(["b", "a", "c"]);
  });
});
