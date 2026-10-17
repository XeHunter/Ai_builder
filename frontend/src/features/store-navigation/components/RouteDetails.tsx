/** Route summary (distance, savings, algorithm) and turn-by-turn steps, shared by list and ad-hoc routes. */
import { CheckCircle2, CornerUpRight, Flag, Footprints, MapPin, PackageCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn, formatNumber, titleCase } from "@/lib/utils";
import type { RouteResponse, RouteStep } from "@/types/api";

const ALGORITHMS: Record<string, string> = {
  held_karp_exact: "Exact optimal order (Held–Karp)",
  nearest_neighbour_2opt: "Nearest neighbour + 2-opt",
  direct: "Direct route",
};

export function algorithmLabel(name: string): string {
  return ALGORITHMS[name] ?? titleCase(name);
}

export function RouteSummary({ route }: { route: RouteResponse }) {
  const saved = route.saved_distance_m;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <div>
        <span className="tabular text-2xl font-semibold">{formatNumber(route.total_distance_m, 1)} m</span>
        <span className="ml-1 text-muted-foreground">walk · {route.stops.length} stop{route.stops.length === 1 ? "" : "s"}</span>
      </div>
      {saved > 0 ? (
        <Badge variant="success">
          Saves {formatNumber(saved, 1)} m vs {formatNumber(route.unoptimized_distance_m, 1)} m in list order
        </Badge>
      ) : (
        <Badge variant="neutral">Already the shortest order</Badge>
      )}
      <Badge variant="info" title="Routing algorithm">
        {algorithmLabel(route.algorithm)}
      </Badge>
      {route.accessible_only && <Badge variant="accent">Step-free route</Badge>}
    </div>
  );
}

const STEP_ICON: Record<RouteStep["type"], typeof MapPin> = {
  start: MapPin,
  walk: Footprints,
  turn: CornerUpRight,
  pick: PackageCheck,
  finish: Flag,
};

/** Ordered instructions. Pick steps are marked done when all their stop keys are in `doneKeys`. */
export function RouteSteps({ route, doneKeys }: { route: RouteResponse; doneKeys?: Set<string> }) {
  return (
    <ol className="space-y-1.5" aria-label="Turn-by-turn directions">
      {route.steps.map((s, i) => {
        const done = s.type === "pick" && !!doneKeys && !!s.stop_keys?.length && s.stop_keys.every((k) => doneKeys.has(k));
        const Icon = done ? CheckCircle2 : STEP_ICON[s.type] ?? MapPin;
        return (
          <li key={i} className={cn("flex items-start gap-2.5 rounded-md px-2 py-1.5 text-sm", s.type === "pick" && "bg-muted/60", done && "opacity-60")}>
            <Icon className={cn("mt-0.5 size-4 shrink-0", done ? "text-success" : s.type === "pick" ? "text-primary" : "text-muted-foreground")} aria-hidden />
            <span className={cn("flex-1", done && "line-through")}>{s.instruction}</span>
            {s.distance_m > 0 && <span className="tabular shrink-0 text-xs text-muted-foreground">{formatNumber(s.distance_m, 1)} m</span>}
            {done && <span className="sr-only">(collected)</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function UnroutedList({ route }: { route: RouteResponse }) {
  if (!route.unrouted.length) return null;
  return (
    <div className="rounded-md border border-warning/30 bg-warning-soft p-3 text-sm">
      <p className="font-medium text-warning">Not on this route</p>
      <ul className="mt-1 space-y-0.5">
        {route.unrouted.map((u, i) => (
          <li key={u.item_id ?? u.product_id ?? i} className="text-foreground/85">
            {u.name} — <span className="text-muted-foreground">{u.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
