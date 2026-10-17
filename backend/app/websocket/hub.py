"""WebSocket fan-out hub for shared shopping lists.

Each API process keeps the set of sockets subscribed to each list. Events are always persisted to
PostgreSQL first (``shopping_list_events``); the hub only delivers them. With REDIS_URL set, events
are also published on ``list:<id>`` so that every API instance delivers them to its own sockets
(horizontal scaling). Without Redis the hub is process-local, which is correct for one API process.
"""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from collections import defaultdict

from fastapi import WebSocket

from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)


class ListHub:
    def __init__(self) -> None:
        self._subs: dict[uuid.UUID, set[WebSocket]] = defaultdict(set)
        self._presence: dict[uuid.UUID, dict[WebSocket, dict]] = defaultdict(dict)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._redis = None
        self._instance = uuid.uuid4().hex

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        url = get_settings().redis_url
        if url and self._redis is None:
            try:
                import redis

                self._redis = redis.Redis.from_url(url)
                self._redis.ping()
                threading.Thread(target=self._redis_listener, daemon=True, name="list-hub-redis").start()
                log.info("List hub using Redis pub/sub for cross-instance delivery")
            except Exception as exc:  # pragma: no cover - environment dependent
                log.warning("Redis unavailable for WebSocket fan-out (%s); using process-local hub", exc)
                self._redis = None

    async def join(self, list_id: uuid.UUID, ws: WebSocket, user: dict) -> None:
        self._subs[list_id].add(ws)
        self._presence[list_id][ws] = user
        await self._send_local(list_id, {"type": "presence", "members_online": self.online(list_id)})

    async def leave(self, list_id: uuid.UUID, ws: WebSocket) -> None:
        self._subs[list_id].discard(ws)
        self._presence[list_id].pop(ws, None)
        await self._send_local(list_id, {"type": "presence", "members_online": self.online(list_id)})

    def online(self, list_id: uuid.UUID) -> list[dict]:
        seen, out = set(), []
        for u in self._presence[list_id].values():
            if u["user_id"] not in seen:
                seen.add(u["user_id"])
                out.append(u)
        return out

    async def _send_local(self, list_id: uuid.UUID, message: dict) -> None:
        dead = []
        for ws in list(self._subs.get(list_id, ())):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._subs[list_id].discard(ws)
            self._presence[list_id].pop(ws, None)

    def publish(self, list_id: uuid.UUID, message: dict) -> None:
        """Thread-safe publish callable from sync request handlers and the WebSocket loop."""
        if self._redis is not None:
            try:
                self._redis.publish(f"list:{list_id}", json.dumps({"src": self._instance, "msg": message}))
            except Exception as exc:  # pragma: no cover
                log.warning("Redis publish failed: %s", exc)
        self._deliver(list_id, message)

    def _deliver(self, list_id: uuid.UUID, message: dict) -> None:
        if self._loop is None or not self._subs.get(list_id):
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            self._loop.create_task(self._send_local(list_id, message))
        else:
            asyncio.run_coroutine_threadsafe(self._send_local(list_id, message), self._loop)

    def _redis_listener(self) -> None:  # pragma: no cover - requires Redis
        pubsub = self._redis.pubsub()
        pubsub.psubscribe("list:*")
        for raw in pubsub.listen():
            if raw.get("type") != "pmessage":
                continue
            try:
                data = json.loads(raw["data"])
                if data.get("src") == self._instance:
                    continue
                list_id = uuid.UUID(raw["channel"].decode().split(":", 1)[1])
                self._deliver(list_id, data["msg"])
            except Exception as exc:
                log.warning("Bad pub/sub message: %s", exc)


hub = ListHub()
