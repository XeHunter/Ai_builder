"""Fixed-window rate limiter.

Uses Redis when REDIS_URL is configured (shared across API instances); otherwise an
in-process dictionary, which is correct for a single local process only.
"""

from __future__ import annotations

import threading
import time

from app.core.config import get_settings
from app.core.exceptions import RateLimitedError
from app.core.logging import get_logger

log = get_logger(__name__)


class RateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._windows: dict[str, tuple[int, int]] = {}
        self._redis = None
        url = get_settings().redis_url
        if url:
            try:
                import redis

                self._redis = redis.Redis.from_url(url, socket_timeout=0.5)
                self._redis.ping()
            except Exception as exc:  # pragma: no cover - depends on environment
                log.warning("Redis unavailable for rate limiting, using in-process limiter: %s", exc)
                self._redis = None

    def hit(self, key: str, limit: int, window_seconds: int = 60) -> None:
        window = int(time.time() // window_seconds)
        if self._redis is not None:
            try:
                rkey = f"rl:{key}:{window}"
                count = self._redis.incr(rkey)
                if count == 1:
                    self._redis.expire(rkey, window_seconds)
                if count > limit:
                    raise RateLimitedError("Too many requests, please retry shortly")
                return
            except RateLimitedError:
                raise
            except Exception:  # pragma: no cover
                pass
        with self._lock:
            w, count = self._windows.get(key, (window, 0))
            if w != window:
                w, count = window, 0
            count += 1
            self._windows[key] = (w, count)
            if len(self._windows) > 10_000:
                self._windows = {k: v for k, v in self._windows.items() if v[0] == window}
        if count > limit:
            raise RateLimitedError("Too many requests, please retry shortly")

    def reset(self) -> None:
        with self._lock:
            self._windows.clear()


rate_limiter = RateLimiter()
