"""Multi-channel fraud shield: deterministic rules + statistical anomaly scores + human review.

Deterministic rules (configurable per merchant in ``fraud_rules``) each contribute a weight and an
explanation. The IsolationForest percentile is reported separately. Combined risk:

    risk = min(100, 0.75 * rule_score + 0.25 * anomaly_percentile)

An alert is opened when risk >= the merchant's threshold or a high-certainty rule (duplicate
receipt, receipt/product mismatch) fires. Alerts only *queue cases for human review*: nothing here
blocks a customer, rejects a return or bans an account. No demographic attributes are used.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

import numpy as np
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.analytics.anomaly_detection.isolation import score as anomaly_score
from app.core.exceptions import BusinessRuleError, NotFoundError
from app.db.models import (
    AccountSecurityEvent,
    FraudAlert,
    FraudInvestigation,
    FraudLabel,
    FraudRule,
    InvestigationNote,
    SalesTransaction,
    StockAdjustment,
    User,
)
from app.services import pricing_service
from app.services.audit_service import record_audit
from app.services.notification_service import notify_merchant_staff

DEFAULT_RULES: list[dict] = [
    {"code": "refund_frequency", "name": "Frequent returns", "weight": 40, "params": {"max_returns_30d": 4},
     "description": "Customer made more returns in 30 days than the configured limit."},
    {"code": "duplicate_receipt", "name": "Receipt already refunded", "weight": 45, "params": {},
     "description": "A return references a receipt that has already been refunded."},
    {"code": "receipt_mismatch", "name": "Receipt/product mismatch", "weight": 45, "params": {},
     "description": "Returned products or quantities do not match the original receipt."},
    {"code": "high_value_return", "name": "High-value return", "weight": 15, "params": {"min_value": 10000},
     "description": "Return value above the configured amount."},
    {"code": "checkout_discrepancy", "name": "Self-checkout quantity discrepancy", "weight": 35, "params": {},
     "description": "Bagging-scale quantity exceeds the charged quantity at self-checkout."},
    {"code": "transaction_velocity", "name": "Transaction velocity", "weight": 40,
     "params": {"max_txn_per_hour": 4},
     "description": "Unusually many transactions from one account within an hour."},
    {"code": "account_security", "name": "Recent account-security event", "weight": 30, "params": {"hours": 24},
     "description": "Return or high-value purchase shortly after a password reset or new-device login."},
    {"code": "inventory_adjustment", "name": "Inventory adjustment anomaly", "weight": 40,
     "params": {"max_manual_writeoffs_7d": 3, "min_units": 10},
     "description": "Repeated large manual stock write-offs by the same staff member."},
]
HARD_RULES = {"duplicate_receipt", "receipt_mismatch"}


def ensure_rules(db: Session, merchant_id: uuid.UUID) -> dict[str, FraudRule]:
    rules = {r.code: r for r in db.scalars(select(FraudRule).where(FraudRule.merchant_id == merchant_id))}
    for spec in DEFAULT_RULES:
        if spec["code"] not in rules:
            r = FraudRule(merchant_id=merchant_id, **spec)
            db.add(r)
            rules[r.code] = r
    db.flush()
    return rules


def _level(risk: float) -> str:
    return "high" if risk >= 75 else "medium" if risk >= 50 else "low"


def scan(db: Session, merchant_id: uuid.UUID, days: int = 30, now: datetime | None = None) -> dict:
    now = now or datetime.now(UTC)
    rules = {c: r for c, r in ensure_rules(db, merchant_id).items() if r.is_active}
    threshold = pricing_service.merchant_settings(db, merchant_id).fraud_alert_threshold
    since = now - timedelta(days=days)
    txns = db.scalars(select(SalesTransaction).where(
        SalesTransaction.merchant_id == merchant_id,
        SalesTransaction.occurred_at >= since - timedelta(days=30),
        or_(SalesTransaction.customer_id.is_not(None), SalesTransaction.transaction_type == "return",
            SalesTransaction.channel == "self_checkout"),
    ).order_by(SalesTransaction.occurred_at)).all()
    by_customer: dict[uuid.UUID, list[SalesTransaction]] = defaultdict(list)
    for t in txns:
        if t.customer_id:
            by_customer[t.customer_id].append(t)
    originals = {t.id: t for t in txns}
    missing = {t.original_transaction_id for t in txns if t.original_transaction_id and t.original_transaction_id not in originals}
    if missing:
        for o in db.scalars(select(SalesTransaction).where(SalesTransaction.id.in_(missing))):
            originals[o.id] = o
    returns_by_original: dict[uuid.UUID, list[SalesTransaction]] = defaultdict(list)
    for t in txns:
        if t.transaction_type == "return" and t.original_transaction_id:
            returns_by_original[t.original_transaction_id].append(t)
    sec_events: dict[uuid.UUID, list[AccountSecurityEvent]] = defaultdict(list)
    for e in db.scalars(select(AccountSecurityEvent).where(AccountSecurityEvent.occurred_at >= since - timedelta(days=2),
                                                           AccountSecurityEvent.event_type.in_(("password_reset", "new_device", "email_change")))):
        sec_events[e.user_id].append(e)

    scope = [t for t in txns if t.occurred_at >= since and (t.transaction_type == "return" or t.channel == "self_checkout" or t.customer_id)]
    feats, signals_list = [], []
    for t in scope:
        signals = []
        hist = by_customer.get(t.customer_id, []) if t.customer_id else []
        window = [h for h in hist if t.occurred_at - timedelta(days=30) <= h.occurred_at <= t.occurred_at]
        returns_30 = [h for h in window if h.transaction_type == "return"]
        prev = [h for h in hist if h.occurred_at < t.occurred_at]
        mins_since_prev = (t.occurred_at - prev[-1].occurred_at).total_seconds() / 60 if prev else 10_000
        discrepancy = sum(max((i.detected_quantity or i.quantity) - i.quantity, 0) for i in t.items)
        high_value = sum(float(i.line_total) for i in t.items if float(i.unit_price) >= 5000)
        feats.append([float(t.total), t.item_count, 1.0 if t.transaction_type == "return" else 0.0, len(returns_30),
                      sum(float(h.total) for h in returns_30), min(mins_since_prev, 10_000), discrepancy,
                      high_value / float(t.total) if float(t.total) else 0.0])

        if t.transaction_type == "return":
            r = rules.get("refund_frequency")
            limit = r.params.get("max_returns_30d", 4) if r else 0
            if r and len(returns_30) > limit:
                signals.append(_sig(r, f"{len(returns_30)} returns in 30 days (limit {limit})", len(returns_30),
                                    extra=min(30, 10 * (len(returns_30) - limit - 1))))
            orig = originals.get(t.original_transaction_id) if t.original_transaction_id else None
            r = rules.get("duplicate_receipt")
            if r and orig:
                earlier = [x for x in returns_by_original[orig.id] if x.occurred_at < t.occurred_at and x.id != t.id]
                if earlier:
                    signals.append(_sig(r, f"Receipt {orig.receipt_number} was already refunded {len(earlier)} time(s)",
                                        len(earlier)))
            r = rules.get("receipt_mismatch")
            if r and orig:
                orig_qty: dict = defaultdict(int)
                for i in orig.items:
                    orig_qty[i.product_id] += i.quantity
                bad = [i for i in t.items if i.quantity > orig_qty.get(i.product_id, 0)]
                if bad:
                    signals.append(_sig(r, f"{len(bad)} returned line(s) not on the original receipt", len(bad)))
            r = rules.get("high_value_return")
            if r and float(t.total) >= r.params.get("min_value", 10000):
                signals.append(_sig(r, f"Return value ₹{float(t.total):,.0f}", float(t.total)))
        r = rules.get("checkout_discrepancy")
        if r and t.channel == "self_checkout" and discrepancy > 0:
            signals.append(_sig(r, f"Bagging scale detected {discrepancy} more item(s) than were charged", discrepancy,
                                extra=min(25, 5 * (discrepancy - 1))))
        r = rules.get("transaction_velocity")
        if r and t.customer_id:
            hour = [h for h in hist if t.occurred_at - timedelta(hours=1) <= h.occurred_at <= t.occurred_at]
            limit = r.params.get("max_txn_per_hour", 4)
            if len(hour) > limit:
                signals.append(_sig(r, f"{len(hour)} transactions within one hour", len(hour),
                                    extra=min(30, 10 * (len(hour) - limit - 1))))
        r = rules.get("account_security")
        if r and t.customer_id and (t.transaction_type == "return" or float(t.total) >= 10000):
            hrs = r.params.get("hours", 24)
            recent = [e for e in sec_events.get(t.customer_id, [])
                      if timedelta(0) <= t.occurred_at - e.occurred_at <= timedelta(hours=hrs)]
            if recent:
                signals.append(_sig(r, f"{', '.join(sorted({e.event_type for e in recent}))} within {hrs} h before this transaction",
                                    len(recent)))
        signals_list.append(signals)

    anomaly = anomaly_score(np.asarray(feats, dtype=float)) if feats else np.zeros(0)
    created = updated = 0
    for t, signals, a in zip(scope, signals_list, anomaly, strict=True):
        rule_score = min(100.0, float(sum(s["weight"] for s in signals)))
        risk = round(min(100.0, 0.75 * rule_score + 0.25 * float(a)), 1)
        hard = any(s["code"] in HARD_RULES for s in signals)
        if not signals or (risk < threshold and not hard):
            continue
        c, u = _upsert_alert(db, merchant_id, f"txn:{t.id}", subject_type="transaction", subject_ref=t.receipt_number,
                             store_id=t.store_id, transaction_id=t.id, customer_id=t.customer_id, rule_score=rule_score,
                             anomaly=round(float(a), 1), risk=risk, signals=signals, when=t.occurred_at)
        created += c
        updated += u
    c2 = _scan_inventory(db, merchant_id, rules.get("inventory_adjustment"), now, threshold)
    if created + c2:
        notify_merchant_staff(db, merchant_id, "fraud.investigate", notification_type="fraud_review",
                              title=f"{created + c2} new transactions need fraud review",
                              body="New alerts are waiting in the review queue. Scores prioritise review; they are not findings.",
                              idempotency_key=f"fraud-scan:{merchant_id}:{now:%Y%m%d%H}", link="/merchant/fraud")
    db.commit()
    return {"transactions_scored": len(scope), "alerts_created": created + c2, "alerts_updated": updated,
            "threshold": threshold}


def _sig(rule: FraudRule, detail: str, value: float, extra: int = 0) -> dict:
    """One fired rule. ``extra`` scales the weight with severity (e.g. how far over the limit)."""
    return {"code": rule.code, "name": rule.name, "weight": rule.weight + max(extra, 0), "detail": detail,
            "value": value, "kind": "deterministic_rule"}


def _upsert_alert(db: Session, merchant_id: uuid.UUID, key: str, *, subject_type: str, subject_ref: str,
                  store_id, transaction_id, customer_id, rule_score: float, anomaly: float | None, risk: float,
                  signals: list[dict], when: datetime) -> tuple[int, int]:
    summary = "; ".join(s["detail"] for s in signals)
    existing = db.scalars(select(FraudAlert).where(FraudAlert.merchant_id == merchant_id, FraudAlert.dedupe_key == key)).first()
    if existing:
        if existing.status == "open":
            existing.rule_score, existing.anomaly_score, existing.risk_score = rule_score, anomaly, risk
            existing.risk_level, existing.signals, existing.summary = _level(risk), signals, summary
        return 0, 1
    alert = FraudAlert(merchant_id=merchant_id, store_id=store_id, transaction_id=transaction_id, customer_id=customer_id,
                       subject_type=subject_type, subject_ref=subject_ref, rule_score=rule_score, anomaly_score=anomaly,
                       risk_score=risk, risk_level=_level(risk), signals=signals, summary=summary, dedupe_key=key,
                       detected_at=when)
    db.add(alert)
    db.flush()
    return 1, 0


def _scan_inventory(db: Session, merchant_id: uuid.UUID, rule: FraudRule | None, now: datetime, threshold: int) -> int:
    if rule is None:
        return 0
    since = now - timedelta(days=7)
    adj = db.scalars(select(StockAdjustment).where(StockAdjustment.merchant_id == merchant_id,
                                                   StockAdjustment.created_at >= since, StockAdjustment.delta < 0,
                                                   StockAdjustment.reason.in_(("damage", "manual", "count_correction")),
                                                   StockAdjustment.actor_id.is_not(None))).all()
    by_actor: dict[uuid.UUID, list[StockAdjustment]] = defaultdict(list)
    for a in adj:
        if -a.delta >= rule.params.get("min_units", 10):
            by_actor[a.actor_id].append(a)
    created = 0
    for actor_id, rows in by_actor.items():
        if len(rows) <= rule.params.get("max_manual_writeoffs_7d", 3):
            continue
        actor = db.get(User, actor_id)
        units = -sum(r.delta for r in rows)
        sig = _sig(rule, f"{len(rows)} manual write-offs totalling {units} units in 7 days by {actor.full_name if actor else 'unknown'}",
                   len(rows))
        rule_score = float(rule.weight + min(30, 5 * (len(rows) - 3)))
        c, _ = _upsert_alert(db, merchant_id, f"inv:{actor_id}:{now:%G-W%V}", subject_type="inventory",
                             subject_ref=f"staff:{actor.email if actor else actor_id}", store_id=rows[0].store_id,
                             transaction_id=None, customer_id=None, rule_score=rule_score, anomaly=None,
                             risk=max(rule_score, float(threshold)), signals=[sig], when=rows[-1].created_at)
        created += c
    return created


def get_alert(db: Session, merchant_id: uuid.UUID, alert_id: uuid.UUID) -> FraudAlert:
    a = db.get(FraudAlert, alert_id)
    if a is None or a.merchant_id != merchant_id:
        raise NotFoundError("Alert not found")
    return a


def open_investigation(db: Session, alert: FraudAlert, actor: User) -> FraudInvestigation:
    if alert.investigation:
        return alert.investigation
    inv = FraudInvestigation(alert_id=alert.id, assignee_id=actor.id, status="open")
    db.add(inv)
    alert.status = "in_review"
    db.flush()
    record_audit(db, action="fraud.investigation.opened", entity_type="fraud_alert", entity_id=alert.id,
                 summary=f"Investigation opened for {alert.subject_ref}", actor=actor, merchant_id=alert.merchant_id)
    db.refresh(alert)
    return inv


def add_note(db: Session, alert: FraudAlert, actor: User, note: str) -> InvestigationNote:
    inv = open_investigation(db, alert, actor)
    n = InvestigationNote(investigation_id=inv.id, author_id=actor.id, note=note)
    db.add(n)
    record_audit(db, action="fraud.investigation.note", entity_type="fraud_alert", entity_id=alert.id,
                 summary="Reviewer note added", actor=actor, merchant_id=alert.merchant_id)
    return n


OUTCOMES = {"confirmed_fraud", "false_positive", "inconclusive"}


def close(db: Session, alert: FraudAlert, actor: User, outcome: str, note: str) -> FraudAlert:
    if outcome not in OUTCOMES:
        raise BusinessRuleError(f"Outcome must be one of {sorted(OUTCOMES)}")
    if not note or len(note.strip()) < 5:
        raise BusinessRuleError("A reviewer note explaining the outcome is required")
    inv = open_investigation(db, alert, actor)
    db.add(InvestigationNote(investigation_id=inv.id, author_id=actor.id, note=f"[{outcome}] {note}"))
    inv.status, inv.outcome, inv.closed_at = "closed", outcome, datetime.now(UTC)
    alert.status, alert.outcome = "closed", outcome
    record_audit(db, action="fraud.investigation.closed", entity_type="fraud_alert", entity_id=alert.id,
                 summary=f"Closed as {outcome}", actor=actor, merchant_id=alert.merchant_id,
                 after={"outcome": outcome})
    return alert


def escalate(db: Session, alert: FraudAlert, actor: User, note: str | None) -> FraudAlert:
    open_investigation(db, alert, actor)
    alert.status = "escalated"
    if note:
        add_note(db, alert, actor, f"[escalated] {note}")
    record_audit(db, action="fraud.alert.escalated", entity_type="fraud_alert", entity_id=alert.id,
                 summary="Escalated for senior review", actor=actor, merchant_id=alert.merchant_id)
    return alert


def evaluate(db: Session, merchant_id: uuid.UUID) -> dict:
    """Precision/recall of transaction alerts against (synthetic) ground-truth labels, and reviewer outcomes."""
    labels = dict(db.execute(select(FraudLabel.transaction_id, FraudLabel.is_fraud)
                             .join(SalesTransaction, SalesTransaction.id == FraudLabel.transaction_id)
                             .where(SalesTransaction.merchant_id == merchant_id)).all())
    alerts = db.scalars(select(FraudAlert).where(FraudAlert.merchant_id == merchant_id,
                                                 FraudAlert.subject_type == "transaction")).all()
    flagged = {a.transaction_id for a in alerts}
    positives = {t for t, f in labels.items() if f}
    tp = len(flagged & positives)
    fp = len([t for t in flagged if t in labels and not labels[t]]) + len([t for t in flagged if t not in labels])
    fn = len(positives - flagged)
    reviewed = [a for a in alerts if a.outcome]
    confirmed = sum(1 for a in reviewed if a.outcome == "confirmed_fraud")
    return {
        "labelled_transactions": len(labels), "label_source": "synthetic" if labels else None,
        "alerts": len(alerts), "true_positives": tp, "false_positives": fp, "false_negatives": fn,
        "precision": round(tp / (tp + fp), 3) if tp + fp else None,
        "recall": round(tp / (tp + fn), 3) if tp + fn else None,
        "reviewed_alerts": len(reviewed),
        "reviewer_confirmed_rate": round(confirmed / len(reviewed), 3) if reviewed else None,
        "note": "Unlabelled flagged transactions count as false positives. Labels are synthetic demo data.",
    }
