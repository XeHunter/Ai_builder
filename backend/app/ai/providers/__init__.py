"""Provider factory. AI_PROVIDER selects the implementation; missing keys fall back to the demo provider."""

from __future__ import annotations

from functools import lru_cache

from app.ai.providers.base import AIProvider, AIProviderError
from app.ai.providers.demo import DemoProvider
from app.core.config import get_settings
from app.core.logging import get_logger

log = get_logger(__name__)

__all__ = ["AIProvider", "AIProviderError", "DemoProvider", "get_ai_provider"]


@lru_cache
def get_ai_provider() -> AIProvider:
    s = get_settings()
    if s.ai_provider == "openai" and s.openai_api_key:
        from app.ai.providers.openai_provider import OpenAIProvider

        return OpenAIProvider(s.openai_api_key, s.openai_base_url, s.openai_chat_model, s.openai_embedding_model,
                              s.embedding_dimensions, s.ai_request_timeout_seconds)
    if s.ai_provider == "gemini" and s.gemini_api_key:
        from app.ai.providers.gemini_provider import GeminiProvider

        return GeminiProvider(s.gemini_api_key, s.gemini_base_url, s.gemini_chat_model, s.gemini_embedding_model,
                              s.embedding_dimensions, s.ai_request_timeout_seconds)
    if s.ai_provider != "demo":
        log.warning("AI_PROVIDER=%s but no API key configured; using deterministic demo provider", s.ai_provider)
    return DemoProvider(s.embedding_dimensions)
