"""Unit tests for pure algorithms: pricing guardrails, routing, association rules, forecasting."""

import itertools
import math
import random
import uuid
from datetime import date, timedelta
from decimal import Decimal

import numpy as np
import pytest

from app.analytics.basket_analysis.association import InsufficientData, mine_pair_rules
from app.analytics.forecasting.models import (
    SeriesInput,
    forecast_product,
    metrics,
    seasonal_naive,
    weather_ridge,
)
from app.services import navigation_service as nav
from app.services.pricing_policy import (
    MarkdownInput,
    compute_markdown,
    price_floor,
    promotion_price,
    validate_price,
)

# ----------------------------------------------------------------------------- pricing


def md(**kw) -> MarkdownInput:
    base = dict(current_price=Decimal("72"), unit_cost=Decimal("54"), min_allowed_price=Decimal("56"), quantity=40,
                hours_left=30, daily_velocity=15)
    base.update(kw)
    return MarkdownInput(**base)


def test_price_floor_uses_max_of_margin_and_minimum():
    assert price_floor(Decimal("50"), Decimal("52"), 0) == Decimal("52")
    assert price_floor(Decimal("50"), Decimal("40"), 10) == Decimal("55.00")
    assert price_floor(Decimal("50"), None, 0) == Decimal("50.00")


def test_markdown_respects_floor_and_tier_cap():
    d = compute_markdown(md())
    assert d.action == "markdown"
    assert d.proposed_price >= d.floor_price
    assert d.discount_pct <= 30  # 48 h tier cap
    assert d.discount_pct % 5 == 0
    assert d.discount_pct == 20  # floor 56 on 72 allows at most 22% -> 20% step
    assert d.send_to_clearance  # expected leftover remains


def test_no_markdown_when_expected_to_sell_through():
    d = compute_markdown(md(quantity=10, daily_velocity=30))
    assert d.action == "none" and d.proposed_price is None


def test_withdraw_when_past_sell_by():
    assert compute_markdown(md(hours_left=-1)).action == "withdraw"


def test_clearance_only_when_floor_blocks_markdown():
    d = compute_markdown(md(current_price=Decimal("56.50")))
    assert d.action == "clearance_only" and d.send_to_clearance


def test_markdown_is_proportional_not_fixed():
    small = compute_markdown(md(quantity=24, daily_velocity=17, hours_left=30))
    large = compute_markdown(md(quantity=40, daily_velocity=6, hours_left=30, min_allowed_price=Decimal("30"),
                                unit_cost=Decimal("30")))
    assert small.discount_pct < large.discount_pct


def test_merchant_max_markdown_is_enforced():
    d = compute_markdown(md(min_allowed_price=Decimal("10"), unit_cost=Decimal("10"), hours_left=10,
                            daily_velocity=1, max_markdown_pct=15))
    assert d.discount_pct <= 15


def test_validate_price_reports_violations():
    assert validate_price(Decimal("40"), Decimal("72"), Decimal("56"), 50)  # below floor
    assert validate_price(Decimal("30"), Decimal("100"), Decimal("10"), 50)  # > max markdown
    assert validate_price(Decimal("60"), Decimal("72"), Decimal("56"), 50) == []


def test_promotion_price():
    assert promotion_price(Decimal("290"), "percent_off", Decimal("10")) == Decimal("261.00")
    assert promotion_price(Decimal("290"), "amount_off", Decimal("40")) == Decimal("250.00")


# ----------------------------------------------------------------------------- routing


class _N:
    def __init__(self, nid, code, x, y, kind="walkway", label=None):
        self.id, self.code, self.x, self.y, self.kind, self.label = nid, code, x, y, kind, label


def grid_graph(w=6, h=6) -> nav.Graph:
    nodes, g = {}, None
    ids = {}
    for x in range(w):
        for y in range(h):
            nid = uuid.uuid4()
            ids[(x, y)] = nid
            nodes[nid] = _N(nid, f"{x},{y}", float(x * 3), float(y * 3), "entrance" if (x, y) == (0, 0) else "walkway")
    g = nav.Graph(layout_id=uuid.uuid4(), nodes=nodes, adj={n: [] for n in nodes})
    for (x, y), nid in ids.items():
        for dx, dy in ((1, 0), (0, 1)):
            if (x + dx, y + dy) in ids:
                other = ids[(x + dx, y + dy)]
                g.adj[nid].append((other, 3.0))
                g.adj[other].append((nid, 3.0))
    g.by_code = {n.code: n.id for n in nodes.values()}
    return g


def test_dijkstra_manhattan_distance_on_grid():
    g = grid_graph()
    d, path = nav.shortest_path(g, g.by_code["0,0"], g.by_code["4,3"])
    assert d == pytest.approx(21.0)
    assert len(path) == 8


def _brute(d, n):
    best = math.inf
    for perm in itertools.permutations(range(1, n + 1)):
        seq = [0, *perm, n + 1]
        best = min(best, sum(d[a][b] for a, b in zip(seq, seq[1:], strict=False)))
    return best


@pytest.mark.parametrize("seed", range(5))
def test_held_karp_matches_brute_force(seed):
    rng = random.Random(seed)
    g = grid_graph()
    codes = [f"{rng.randint(0, 5)},{rng.randint(0, 5)}" for _ in range(6)]
    stops = [nav.Stop(key=str(i), label=c, node_id=g.by_code[c]) for i, c in enumerate(codes)]
    start, end = g.by_code["0,0"], g.by_code["5,5"]
    plan = nav.plan_route(g, start, stops, end)
    distinct = list(dict.fromkeys(s.node_id for s in stops))
    pts = [start, *distinct, end]
    dm = [[nav.shortest_path(g, a, b)[0] for b in pts] for a in pts]
    assert plan.total_distance_m == pytest.approx(round(_brute(dm, len(distinct)), 1), abs=0.11)
    assert plan.total_distance_m <= plan.naive_distance_m + 1e-9
    picked = [k for s in plan.steps if s["type"] == "pick" for k in s["stop_keys"]]
    assert sorted(picked) == sorted(s.key for s in stops)


def test_two_opt_used_for_many_stops_and_not_worse_than_naive():
    g = grid_graph(8, 8)
    rng = random.Random(7)
    stops = [nav.Stop(key=str(i), label="x", node_id=g.by_code[f"{rng.randint(0, 7)},{rng.randint(0, 7)}"]) for i in range(20)]
    plan = nav.plan_route(g, g.by_code["0,0"], stops, g.by_code["7,7"])
    if len({s.node_id for s in stops}) > nav.EXACT_LIMIT:
        assert plan.algorithm == "nearest_neighbour_2opt"
    assert plan.total_distance_m <= plan.naive_distance_m


# ----------------------------------------------------------------------------- association rules


def test_pair_rules_exact_metrics():
    baskets = [frozenset("AB")] * 30 + [frozenset("A")] * 20 + [frozenset("B")] * 10 + [frozenset("C")] * 140
    rules, support, n = mine_pair_rules(baskets, min_support=0.01, min_confidence=0.1, min_pair_count=10,
                                        min_transactions=100)
    assert n == 200
    r = next(r for r in rules if r.antecedent == "A" and r.consequent == "B")
    assert r.pair_count == 30
    assert r.support == pytest.approx(30 / 200)
    assert r.confidence == pytest.approx(30 / 50)
    assert r.lift == pytest.approx((30 / 50) / (40 / 200), rel=1e-3)
    assert not any("C" in (x.antecedent, x.consequent) for x in rules)


def test_pair_rules_require_enough_transactions_and_pairs():
    with pytest.raises(InsufficientData):
        mine_pair_rules([frozenset("AB")] * 50, min_transactions=200)
    rules, _, _ = mine_pair_rules([frozenset("AB")] * 5 + [frozenset("C")] * 300, min_pair_count=20)
    assert rules == []


# ----------------------------------------------------------------------------- forecasting


def _series(n=120, h=14, rain_effect=0.0, seed=0):
    rng = np.random.default_rng(seed)
    start = date(2026, 1, 1)
    dates = [start + timedelta(days=i) for i in range(n + h)]
    precip = np.where(rng.random(n + h) < 0.3, rng.uniform(5, 40, n + h), 0.0)
    exog = np.column_stack([precip, (precip >= 5).astype(float), np.full(n + h, 30.0), np.zeros(n + h)])
    weekly = np.array([10, 10, 11, 12, 14, 20, 18], dtype=float)
    y = np.array([weekly[d.weekday()] for d in dates]) + rain_effect * (precip >= 5) + rng.normal(0, 0.8, n + h)
    y = np.clip(y, 0, None)
    return SeriesInput(y[:n], dates[:n], exog[:n], dates[n:], exog[n:]), y[n:]


def test_seasonal_naive_captures_weekly_pattern():
    s, actual = _series()
    out = seasonal_naive(s)
    assert metrics(actual, out.mean)["mae"] < 1.5
    assert np.all(out.lower <= out.mean) and np.all(out.upper >= out.mean)


def test_weather_model_beats_baseline_when_rain_matters():
    s, actual = _series(rain_effect=12.0, seed=3)
    ridge, naive = weather_ridge(s), seasonal_naive(s)
    assert metrics(actual, ridge.mean)["mae"] < metrics(actual, naive.mean)["mae"]
    pf = forecast_product(s, backtest_days=14)
    assert pf.chosen.model == "weather_ridge"
    assert pf.backtests["weather_ridge"]["mae"] < pf.backtests["seasonal_naive"]["mae"]
    assert pf.rain_effect["ratio"] > 1.3


def test_low_volume_series_falls_back_to_baseline():
    s, _ = _series()
    s.history = np.zeros_like(s.history)
    s.history[::17] = 1
    pf = forecast_product(s)
    assert pf.chosen.model == "seasonal_naive"
    assert np.all(pf.chosen.mean >= 0)
