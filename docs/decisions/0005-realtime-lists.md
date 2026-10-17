# ADR-0005: Shared lists via persisted event log + WebSocket delivery

* Status: accepted
* Date: 2026-10-16

## Context
Several family members edit and tick off one list in-store, often on flaky mobile connections.

## Decision
* PostgreSQL is authoritative: items carry a `version`; the list carries a monotonically increasing
  `version` used as the event sequence; each mutation appends a `shopping_list_events` row.
* All mutations (REST and WebSocket) share `apply_operation`; updates may send `expected_version`
  (stale → HTTP 409 / WS `error` with the current item). Collect/uncollect are idempotent, so
  concurrent check-offs never conflict. `client_event_id` makes retries idempotent.
* Clients reconnect with `?last_seq=N` and receive the missed events (or a snapshot if the gap is
  large). Presence (who is online) is ephemeral.
* The hub is process-local; with `REDIS_URL` events are also published to `list:<id>` for
  cross-instance delivery.

## Consequences
* No lost updates; deterministic replay; simple client logic.
* Delivery is at-least-once; clients ignore events with `seq` ≤ their last applied sequence.
