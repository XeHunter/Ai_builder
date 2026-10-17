"""Price publication boundary (POS / electronic shelf labels / e-commerce price feed).

``SimulatedPricePublisher`` is the only implementation: it does not contact any device. It returns
a deterministic reference, and fails deterministically when the merchant's ``pricing_publisher``
integration config is ``disabled`` or lists the SKU in ``settings.fail_skus`` - which lets the demo
and tests exercise the FAILED state. A real adapter would implement the same ``publish`` method.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol


@dataclass
class PublishResult:
    ok: bool
    reference: str | None
    error: str | None = None
    simulated: bool = True


class PricePublisher(Protocol):
    def publish(self, *, store_code: str, sku: str, batch_code: str | None, price: Decimal,
                change_id: str) -> PublishResult: ...


class SimulatedPricePublisher:
    def __init__(self, mode: str = "simulated", settings: dict | None = None) -> None:
        self.mode = mode
        self.settings = settings or {}

    def publish(self, *, store_code: str, sku: str, batch_code: str | None, price: Decimal, change_id: str) -> PublishResult:
        if self.mode == "disabled":
            return PublishResult(False, None, "Price publication integration is disabled for this merchant")
        if sku in set(self.settings.get("fail_skus", [])):
            return PublishResult(False, None, f"Simulated shelf-label controller rejected SKU {sku}")
        ref = "SIM-ESL-" + hashlib.sha1(f"{store_code}:{sku}:{batch_code}:{price}:{change_id}".encode()).hexdigest()[:10].upper()
        return PublishResult(True, ref)
