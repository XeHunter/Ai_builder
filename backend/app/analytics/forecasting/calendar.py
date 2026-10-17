"""Calendar features. Holiday dates are approximate public holidays (India) and are configurable data,
not authoritative; extend ``HOLIDAYS`` or load them from configuration for production use."""

from __future__ import annotations

from datetime import date

HOLIDAYS: set[date] = {
    date(2025, 10, 2), date(2025, 10, 20), date(2025, 10, 21), date(2025, 12, 25),
    date(2026, 1, 1), date(2026, 1, 26), date(2026, 3, 4), date(2026, 3, 21), date(2026, 4, 3),
    date(2026, 5, 1), date(2026, 8, 15), date(2026, 8, 28), date(2026, 9, 14), date(2026, 10, 2),
    date(2026, 10, 20), date(2026, 11, 8), date(2026, 11, 9), date(2026, 12, 25),
    date(2027, 1, 1), date(2027, 1, 26),
}


def is_holiday(d: date) -> bool:
    return d in HOLIDAYS


def is_weekend(d: date) -> bool:
    return d.weekday() >= 5
