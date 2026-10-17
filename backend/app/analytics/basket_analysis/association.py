"""Association-rule mining over transaction baskets (Apriori restricted to item pairs).

For items A, B over N baskets:
    support(A,B)   = count(A and B) / N
    confidence(A→B) = count(A and B) / count(A)
    lift(A→B)      = confidence(A→B) / support(B)
Only items with support >= min_support are paired (the Apriori property: a pair cannot be more
frequent than either item). Rules also need ``pair_count >= min_pair_count`` so tiny coincidences
are not reported. Lift > 1 means the items co-occur more often than independence would predict;
it does not establish that one purchase causes the other.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Hashable, Iterable
from dataclasses import dataclass
from itertools import combinations


@dataclass(frozen=True)
class PairRule:
    antecedent: Hashable
    consequent: Hashable
    pair_count: int
    support: float
    confidence: float
    lift: float
    antecedent_support: float
    consequent_support: float


class InsufficientData(ValueError):
    pass


def mine_pair_rules(baskets: Iterable[frozenset], *, min_support: float = 0.005, min_confidence: float = 0.1,
                    min_pair_count: int = 20, min_transactions: int = 200) -> tuple[list[PairRule], dict, int]:
    baskets = [b for b in baskets if len(b) >= 1]
    n = len(baskets)
    if n < min_transactions:
        raise InsufficientData(f"{n} baskets analysed; at least {min_transactions} are required")
    item_counts: Counter = Counter()
    for b in baskets:
        item_counts.update(b)
    frequent = {i for i, c in item_counts.items() if c / n >= min_support}
    pair_counts: Counter = Counter()
    for b in baskets:
        items = sorted((i for i in b if i in frequent), key=str)
        for a, c in combinations(items, 2):
            pair_counts[(a, c)] += 1
    rules: list[PairRule] = []
    for (a, b), cnt in pair_counts.items():
        if cnt < min_pair_count or cnt / n < min_support:
            continue
        sa, sb, sab = item_counts[a] / n, item_counts[b] / n, cnt / n
        for x, y, sx, sy in ((a, b, sa, sb), (b, a, sb, sa)):
            conf = sab / sx
            if conf >= min_confidence:
                rules.append(PairRule(x, y, cnt, round(sab, 5), round(conf, 4), round(conf / sy, 3), round(sx, 5), round(sy, 5)))
    rules.sort(key=lambda r: (-r.lift, -r.pair_count, str(r.antecedent), str(r.consequent)))
    return rules, {k: v / n for k, v in item_counts.items()}, n
