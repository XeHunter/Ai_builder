"""Pure pricing rules (no database access) so they can be unit-tested exhaustively.

Guardrails enforced here and re-checked at approval and publication time:
* Never below the price floor: max(min_allowed_price, unit_cost * (1 + min_margin_pct/100)).
* Never above the merchant's max_markdown_pct or the time-to-expiry tier cap.
* The engine only ever recommends price *reductions*; it never raises prices because demand is
  trending or stock is scarce.
* No customer attributes are inputs to any pricing function.

The markdown model is an explicit, documented heuristic: expected sales at the current price are
``velocity * days_left``; a markdown of d (fraction) is assumed to raise demand by
``elasticity * d`` (default elasticity 2.0, configurable per rule). This is an assumption, not a
learned model, and is reported as such in the recommendation evidence.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")

DEFAULT_TIERS = [
    {"max_hours": 24, "max_discount_pct": 50},
    {"max_hours": 48, "max_discount_pct": 30},
    {"max_hours": 72, "max_discount_pct": 20},
    {"max_hours": 168, "max_discount_pct": 10},
]


def q2(v: Decimal) -> Decimal:
    return v.quantize(CENT, rounding=ROUND_HALF_UP)


def price_floor(unit_cost: Decimal, min_allowed_price: Decimal | None, min_margin_pct: float) -> Decimal:
    margin_floor = q2(unit_cost * (Decimal(1) + Decimal(str(min_margin_pct)) / Decimal(100)))
    return max(margin_floor, min_allowed_price or Decimal(0))


def margin_pct(price: Decimal, unit_cost: Decimal) -> float:
    if price <= 0:
        return -100.0
    return float(round((price - unit_cost) / price * 100, 2))


def tier_cap(hours_left: float, tiers: list[dict] | None = None) -> int:
    for t in sorted(tiers or DEFAULT_TIERS, key=lambda t: t["max_hours"]):
        if hours_left <= t["max_hours"]:
            return int(t["max_discount_pct"])
    return 0


@dataclass
class MarkdownInput:
    current_price: Decimal
    unit_cost: Decimal
    min_allowed_price: Decimal | None
    quantity: int
    hours_left: float
    daily_velocity: float
    max_markdown_pct: int = 50
    min_margin_pct: float = 0.0
    elasticity: float = 2.0
    tiers: list[dict] | None = None
    step_pct: int = 5
    min_markdown_pct: int = 5


@dataclass
class MarkdownDecision:
    action: str  # none|markdown|clearance_only|withdraw
    discount_pct: int = 0
    proposed_price: Decimal | None = None
    floor_price: Decimal = Decimal(0)
    cap_pct: int = 0
    expected_units_no_action: float = 0.0
    expected_units_with_action: float = 0.0
    expected_leftover_units: float = 0.0
    projected_margin_pct: float = 0.0
    send_to_clearance: bool = False
    reasons: list[str] = field(default_factory=list)


def compute_markdown(i: MarkdownInput) -> MarkdownDecision:
    floor = price_floor(i.unit_cost, i.min_allowed_price, i.min_margin_pct)
    d = MarkdownDecision(action="none", floor_price=floor)
    if i.quantity <= 0:
        d.reasons.append("No remaining stock in this batch.")
        return d
    if i.hours_left <= 0:
        d.action = "withdraw"
        d.reasons.append("Batch is past its sell-by limit and must not be sold; withdraw and write off.")
        return d

    days_left = i.hours_left / 24.0
    expected = max(i.daily_velocity, 0.0) * days_left
    d.expected_units_no_action = round(expected, 1)
    if expected >= i.quantity:
        d.reasons.append(
            f"Expected to sell {expected:.0f} units before expiry at the current price, covering the "
            f"{i.quantity} remaining; no markdown needed."
        )
        d.expected_units_with_action = float(i.quantity)
        return d

    cap = min(tier_cap(i.hours_left, i.tiers), i.max_markdown_pct)
    d.cap_pct = cap
    max_by_floor = 0
    if i.current_price > floor:
        max_by_floor = int(math.floor(float((i.current_price - floor) / i.current_price * 100) + 1e-9))
    allowed = min(cap, max_by_floor)

    if expected <= 0:
        needed = math.inf
    else:
        needed = (i.quantity / expected - 1.0) / max(i.elasticity, 0.01) * 100
    target = i.min_markdown_pct if needed < i.min_markdown_pct else needed
    stepped = int(math.ceil(target / i.step_pct) * i.step_pct) if math.isfinite(target) else allowed
    allowed_stepped = (allowed // i.step_pct) * i.step_pct

    if allowed_stepped < i.min_markdown_pct:
        d.action = "clearance_only"
        d.send_to_clearance = True
        why = "the price floor" if max_by_floor < cap else f"the {cap}% cap for {i.hours_left:.0f} h to expiry"
        d.reasons.append(f"A markdown is not possible because of {why}; move units to the clearance area instead.")
        d.expected_leftover_units = round(max(i.quantity - expected, 0), 1)
        return d

    pct = min(stepped, allowed_stepped)
    price = q2(i.current_price * (Decimal(100) - Decimal(pct)) / Decimal(100))
    if price < floor:  # rounding guard
        price = floor
        pct = int(math.floor(float((i.current_price - floor) / i.current_price * 100)))
    lifted = expected * (1 + i.elasticity * pct / 100)
    d.action = "markdown"
    d.discount_pct = pct
    d.proposed_price = price
    d.expected_units_with_action = round(min(i.quantity, lifted), 1)
    d.expected_leftover_units = round(max(i.quantity - lifted, 0), 1)
    d.projected_margin_pct = margin_pct(price, i.unit_cost)
    d.reasons.append(
        f"{i.quantity} units left with {i.hours_left:.0f} h to sell-by; recent velocity "
        f"{i.daily_velocity:.1f}/day implies ~{expected:.0f} sold at the current price."
    )
    if pct < stepped:
        d.reasons.append(f"Discount limited to {pct}% by {'the price floor' if allowed == max_by_floor else 'policy caps'}.")
    if d.expected_leftover_units > 0:
        d.send_to_clearance = True
        d.reasons.append(f"About {d.expected_leftover_units:.0f} units may still remain; place them in the clearance bin.")
    return d


def validate_price(new_price: Decimal, current_price: Decimal, floor: Decimal, max_markdown_pct: int) -> list[str]:
    """Return a list of guardrail violations (empty when the price is allowed)."""
    problems = []
    if new_price <= 0:
        problems.append("Price must be positive.")
    if new_price < floor:
        problems.append(f"₹{new_price} is below the price floor of ₹{floor}.")
    if current_price > 0 and new_price < current_price:
        pct = float((current_price - new_price) / current_price * 100)
        if pct > max_markdown_pct + 1e-6:
            problems.append(f"A {pct:.1f}% reduction exceeds the maximum markdown of {max_markdown_pct}%.")
    return problems


def promotion_price(regular: Decimal, promo_type: str, value: Decimal) -> Decimal:
    if promo_type == "percent_off":
        return q2(regular * (Decimal(100) - value) / Decimal(100))
    return q2(regular - value)
