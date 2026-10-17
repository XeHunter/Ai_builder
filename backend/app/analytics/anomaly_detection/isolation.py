"""Statistical anomaly scoring of transactions with scikit-learn's IsolationForest.

The model is unsupervised: it ranks transactions by how unusual their behavioural features are
relative to the store's own recent transactions. Scores are converted to a 0-100 percentile so
they are comparable across runs. An anomaly score is a prioritisation signal for human review,
never evidence of wrongdoing on its own.
"""

from __future__ import annotations

import numpy as np
from sklearn.ensemble import IsolationForest

FEATURES = [
    "total",
    "item_count",
    "is_return",
    "customer_returns_30d",
    "customer_return_value_30d",
    "minutes_since_prev_txn",
    "qty_discrepancy",
    "high_value_share",
]


def score(matrix: np.ndarray, random_state: int = 42) -> np.ndarray:
    """Return 0-100 anomaly percentiles (higher = more unusual). Needs at least 50 rows."""
    if matrix.shape[0] < 50:
        return np.zeros(matrix.shape[0])
    x = np.log1p(np.clip(matrix, 0, None))
    model = IsolationForest(n_estimators=200, contamination="auto", random_state=random_state)
    model.fit(x)
    raw = -model.score_samples(x)  # larger = more anomalous
    ranks = raw.argsort().argsort()
    return ranks / max(len(raw) - 1, 1) * 100
