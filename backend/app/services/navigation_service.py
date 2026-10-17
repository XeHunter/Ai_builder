"""In-store navigation over the walkable graph of a store layout.

* Shortest paths: Dijkstra on the weighted, undirected walkway graph (blocked edges removed; when
  ``accessible_only`` is set, non-accessible edges are removed too).
* Multi-stop ordering: an open-path travelling-salesman problem from the start node through every
  stop to the end node (checkout). Solved exactly with Held-Karp dynamic programming for up to
  ``EXACT_LIMIT`` distinct stop nodes, otherwise nearest-neighbour construction + 2-opt improvement.
* Directions: the node path is converted into turn-by-turn steps from heading changes.

Indoor *positioning* is not implemented: the start point is the entrance or a point the shopper picks
on the map. See TECHNICAL_README "Known limitations".
"""

from __future__ import annotations

import heapq
import math
import uuid
from dataclasses import dataclass, field
from itertools import pairwise

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import NavEdge, NavNode, ShelfLocation

EXACT_LIMIT = 11


@dataclass
class Graph:
    layout_id: uuid.UUID
    nodes: dict[uuid.UUID, NavNode]
    adj: dict[uuid.UUID, list[tuple[uuid.UUID, float]]] = field(default_factory=dict)
    by_code: dict[str, uuid.UUID] = field(default_factory=dict)

    def node(self, node_id: uuid.UUID) -> NavNode:
        return self.nodes[node_id]

    def nearest_node(self, x: float, y: float) -> uuid.UUID:
        return min(self.nodes, key=lambda n: (self.nodes[n].x - x) ** 2 + (self.nodes[n].y - y) ** 2)

    def first_of_kind(self, kind: str) -> uuid.UUID | None:
        for nid, n in self.nodes.items():
            if n.kind == kind:
                return nid
        return None


def load_graph(db: Session, layout_id: uuid.UUID, accessible_only: bool = False) -> Graph:
    nodes = {n.id: n for n in db.scalars(select(NavNode).where(NavNode.layout_id == layout_id))}
    if not nodes:
        raise NotFoundError("This store layout has no walkable graph")
    g = Graph(layout_id=layout_id, nodes=nodes, adj={nid: [] for nid in nodes}, by_code={n.code: n.id for n in nodes.values()})
    for e in db.scalars(select(NavEdge).where(NavEdge.layout_id == layout_id)):
        if e.is_blocked or (accessible_only and not e.is_accessible):
            continue
        g.adj[e.from_node_id].append((e.to_node_id, e.distance_m))
        g.adj[e.to_node_id].append((e.from_node_id, e.distance_m))
    return g


def dijkstra(g: Graph, source: uuid.UUID) -> tuple[dict[uuid.UUID, float], dict[uuid.UUID, uuid.UUID]]:
    dist = {source: 0.0}
    prev: dict[uuid.UUID, uuid.UUID] = {}
    heap: list[tuple[float, str, uuid.UUID]] = [(0.0, str(source), source)]
    done: set[uuid.UUID] = set()
    while heap:
        d, _, u = heapq.heappop(heap)
        if u in done:
            continue
        done.add(u)
        for v, w in g.adj.get(u, []):
            nd = d + w
            if nd < dist.get(v, math.inf) - 1e-9:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, str(v), v))
    return dist, prev


def _path(prev: dict[uuid.UUID, uuid.UUID], source: uuid.UUID, target: uuid.UUID) -> list[uuid.UUID]:
    path = [target]
    while path[-1] != source:
        if path[-1] not in prev:
            return []
        path.append(prev[path[-1]])
    return path[::-1]


def shortest_path(g: Graph, a: uuid.UUID, b: uuid.UUID) -> tuple[float, list[uuid.UUID]]:
    dist, prev = dijkstra(g, a)
    if b not in dist:
        raise BusinessRuleError("No walkable path between these points")
    return dist[b], _path(prev, a, b)


def _held_karp(d: list[list[float]], n_stops: int) -> list[int]:
    """Indices: 0 = start, 1..n = stops, n+1 = end. Returns the optimal order of stops (1..n)."""
    full = (1 << n_stops) - 1
    best: dict[tuple[int, int], tuple[float, int]] = {}
    for k in range(n_stops):
        best[(1 << k, k)] = (d[0][k + 1], -1)
    for mask in range(1, full + 1):
        for last in range(n_stops):
            if not mask & (1 << last) or (mask, last) not in best:
                continue
            cost, _ = best[(mask, last)]
            for nxt in range(n_stops):
                if mask & (1 << nxt):
                    continue
                nm = mask | (1 << nxt)
                c = cost + d[last + 1][nxt + 1]
                if (nm, nxt) not in best or c < best[(nm, nxt)][0] - 1e-9:
                    best[(nm, nxt)] = (c, last)
    end = n_stops + 1
    last = min(range(n_stops), key=lambda k: (best[(full, k)][0] + d[k + 1][end], k))
    order, mask = [], full
    while last != -1:
        order.append(last + 1)
        _, p = best[(mask, last)]
        mask ^= 1 << last
        last = p
    return order[::-1]


def _nn_two_opt(d: list[list[float]], n_stops: int) -> list[int]:
    unvisited = set(range(1, n_stops + 1))
    order, cur = [], 0
    while unvisited:
        nxt = min(unvisited, key=lambda k: (d[cur][k], k))
        order.append(nxt)
        unvisited.remove(nxt)
        cur = nxt
    end = n_stops + 1

    def cost(o: list[int]) -> float:
        seq = [0, *o, end]
        return sum(d[a][b] for a, b in pairwise(seq))

    improved = True
    best_cost = cost(order)
    while improved:
        improved = False
        for i in range(len(order) - 1):
            for j in range(i + 1, len(order)):
                cand = order[:i] + order[i : j + 1][::-1] + order[j + 1 :]
                c = cost(cand)
                if c < best_cost - 1e-9:
                    order, best_cost, improved = cand, c, True
    return order


@dataclass
class Stop:
    key: str  # caller-defined id (e.g. shopping-list item id)
    label: str
    node_id: uuid.UUID
    shelf: ShelfLocation | None = None


@dataclass
class RoutePlan:
    ordered_stops: list[list[Stop]]
    node_path: list[uuid.UUID]
    total_distance_m: float
    naive_distance_m: float
    algorithm: str
    steps: list[dict]


def plan_route(g: Graph, start: uuid.UUID, stops: list[Stop], end: uuid.UUID | None) -> RoutePlan:
    # Group stops sharing an access node; they are picked at the same point.
    groups: dict[uuid.UUID, list[Stop]] = {}
    for s in stops:
        groups.setdefault(s.node_id, []).append(s)
    stop_nodes = list(groups)
    end_node = end or start
    points = [start, *stop_nodes, end_node]
    dist_cache: dict[uuid.UUID, tuple[dict, dict]] = {}
    for p in set(points):
        dist_cache[p] = dijkstra(g, p)
    d = [[dist_cache[a][0].get(b, math.inf) for b in points] for a in points]
    if any(math.isinf(d[0][k]) for k in range(len(points))):
        unreachable = [groups[stop_nodes[k - 1]][0].label for k in range(1, len(points) - 1) if math.isinf(d[0][k])]
        raise BusinessRuleError("Some stops are not reachable on the walkable graph", details={"stops": unreachable})
    n = len(stop_nodes)
    if n == 0:
        order: list[int] = []
        algorithm = "direct"
    elif n <= EXACT_LIMIT:
        order = _held_karp(d, n)
        algorithm = "held_karp_exact"
    else:
        order = _nn_two_opt(d, n)
        algorithm = "nearest_neighbour_2opt"

    seq = [0, *order, n + 1]
    total = sum(d[a][b] for a, b in pairwise(seq))
    naive_seq = [0, *range(1, n + 1), n + 1]
    naive = sum(d[a][b] for a, b in pairwise(naive_seq))

    node_path: list[uuid.UUID] = [start]
    for a, b in pairwise(seq):
        pa, pb = points[a], points[b]
        if pa == pb:
            continue
        seg = _path(dist_cache[pa][1], pa, pb)
        node_path.extend(seg[1:])
    ordered = [groups[stop_nodes[k - 1]] for k in order]
    steps = build_directions(g, node_path, {stop_nodes[k - 1]: groups[stop_nodes[k - 1]] for k in order}, end_node)
    return RoutePlan(ordered, node_path, round(total, 1), round(naive, 1), algorithm, steps)


def _heading(a: NavNode, b: NavNode) -> tuple[float, float]:
    dx, dy = b.x - a.x, b.y - a.y
    n = math.hypot(dx, dy) or 1.0
    return dx / n, dy / n


def _side(heading: tuple[float, float], node: NavNode, shelf: ShelfLocation | None) -> str | None:
    if shelf is None:
        return None
    vx, vy = shelf.x - node.x, shelf.y - node.y
    cross = heading[0] * vy - heading[1] * vx  # screen coords (y down): positive = right
    if abs(cross) < 0.2:
        return "ahead"
    return "right" if cross > 0 else "left"


def build_directions(g: Graph, path: list[uuid.UUID], stops_at: dict[uuid.UUID, list[Stop]], end: uuid.UUID) -> list[dict]:
    steps: list[dict] = []
    if not path:
        return steps
    start = g.node(path[0])
    steps.append({"type": "start", "instruction": f"Start at {start.label or start.code}", "x": start.x, "y": start.y,
                  "distance_m": 0.0})
    pending_distance = 0.0
    heading = None
    visited_stops: set[uuid.UUID] = set()
    if path[0] in stops_at:
        visited_stops.add(path[0])
        steps.append(_pick_step(start, stops_at[path[0]], None))
    for i in range(1, len(path)):
        a, b = g.node(path[i - 1]), g.node(path[i])
        h = _heading(a, b)
        seg = math.hypot(b.x - a.x, b.y - a.y)
        if heading is not None:
            cross = heading[0] * h[1] - heading[1] * h[0]
            dot = heading[0] * h[0] + heading[1] * h[1]
            if dot < -0.7:
                turn = "Turn around"
            elif abs(cross) > 0.5:
                turn = "Turn right" if cross > 0 else "Turn left"
            else:
                turn = None
            if turn:
                if pending_distance >= 0.5:
                    steps.append({"type": "walk", "instruction": f"Walk {pending_distance:.0f} m", "x": a.x, "y": a.y,
                                  "distance_m": round(pending_distance, 1)})
                where = f" into {a.label}" if a.label else ""
                steps.append({"type": "turn", "instruction": f"{turn}{where}", "x": a.x, "y": a.y, "distance_m": 0.0})
                pending_distance = 0.0
        pending_distance += seg
        heading = h
        if path[i] in stops_at and path[i] not in visited_stops:
            visited_stops.add(path[i])
            if pending_distance >= 0.5:
                steps.append({"type": "walk", "instruction": f"Walk {pending_distance:.0f} m", "x": b.x, "y": b.y,
                              "distance_m": round(pending_distance, 1)})
                pending_distance = 0.0
            steps.append(_pick_step(b, stops_at[path[i]], heading))
    last = g.node(path[-1])
    if pending_distance >= 0.5:
        steps.append({"type": "walk", "instruction": f"Walk {pending_distance:.0f} m", "x": last.x, "y": last.y,
                      "distance_m": round(pending_distance, 1)})
    end_node = g.node(end)
    steps.append({"type": "finish", "instruction": f"Arrive at {end_node.label or end_node.code}", "x": end_node.x,
                  "y": end_node.y, "distance_m": 0.0})
    return steps


def _pick_step(node: NavNode, stops: list[Stop], heading: tuple[float, float] | None) -> dict:
    parts = []
    for s in stops:
        side = _side(heading, node, s.shelf) if heading else None
        where = f"{s.shelf.code}" if s.shelf else "nearby"
        level = f", shelf level {s.shelf.level}" if s.shelf else ""
        side_txt = f" on your {side}" if side in ("left", "right") else ""
        parts.append(f"{s.label} ({where}{level}){side_txt}")
    return {"type": "pick", "instruction": "Pick up " + "; ".join(parts), "x": node.x, "y": node.y, "distance_m": 0.0,
            "stop_keys": [s.key for s in stops]}


def serialize_path(g: Graph, path: list[uuid.UUID]) -> list[dict]:
    return [{"code": g.node(n).code, "x": g.node(n).x, "y": g.node(n).y} for n in path]
