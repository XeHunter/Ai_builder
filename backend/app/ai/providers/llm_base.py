"""Shared behaviour for LLM-backed providers: prompts, JSON validation and deterministic fallback.

An LLM call that fails (network, quota, invalid JSON, schema mismatch) falls back to the
deterministic DemoProvider for that request so the shopper still gets an answer; the fallback
is reported in the response metadata (``provider_used``).
"""

from __future__ import annotations

import json
from abc import abstractmethod
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.ai.prompts import templates
from app.ai.providers.base import AIProvider, AIProviderError
from app.ai.providers.demo import DemoProvider
from app.ai.schemas import ComposedReply, ImageDescription, ParsedList, ShoppingIntent
from app.core.logging import get_logger

log = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)


class LLMProvider(AIProvider):
    kind = "llm"

    def __init__(self, dimensions: int) -> None:
        self.embedding_dimensions = dimensions
        self._fallback = DemoProvider(dimensions)
        self.last_call_fell_back = False

    @abstractmethod
    def _complete_json(self, system: str, user: str, schema: type[BaseModel], image: tuple[bytes, str] | None = None) -> str: ...

    def _structured(self, system: str, user: str, schema: type[T], image: tuple[bytes, str] | None = None) -> T:
        raw = self._complete_json(system, user, schema, image)
        try:
            return schema.model_validate(json.loads(raw))
        except (json.JSONDecodeError, ValidationError) as exc:
            raise AIProviderError(f"Model output failed schema validation: {exc}") from exc

    def extract_intent(self, message: str, *, context_product: str | None = None) -> ShoppingIntent:
        self.last_call_fell_back = False
        user = message if not context_product else f"(Shopper is viewing: {context_product})\n{message}"
        try:
            return self._structured(templates.INTENT_SYSTEM, user, ShoppingIntent)
        except Exception as exc:
            log.warning("%s intent extraction failed, using deterministic fallback: %s", self.name, exc)
            self.last_call_fell_back = True
            return self._fallback.extract_intent(message, context_product=context_product)

    def parse_shopping_list(self, text: str) -> ParsedList:
        self.last_call_fell_back = False
        try:
            parsed = self._structured(templates.LIST_SYSTEM, text, ParsedList)
            if parsed.items:
                return parsed
        except Exception as exc:
            log.warning("%s list parsing failed, using deterministic fallback: %s", self.name, exc)
        self.last_call_fell_back = True
        return self._fallback.parse_shopping_list(text)

    def compose_reply(self, *, user_message: str, intent: ShoppingIntent, facts: dict) -> ComposedReply:
        self.last_call_fell_back = False
        payload = json.dumps({"shopper_message": user_message, "intent": intent.model_dump(), "facts": facts},
                             default=str)
        try:
            return self._structured(templates.REPLY_SYSTEM, payload, ComposedReply)
        except Exception as exc:
            log.warning("%s reply composition failed, using template: %s", self.name, exc)
            self.last_call_fell_back = True
            return self._fallback.compose_reply(user_message=user_message, intent=intent, facts=facts)

    def describe_image(self, data: bytes, content_type: str) -> ImageDescription | None:
        if not self.supports_vision:
            return None
        try:
            return self._structured(templates.IMAGE_SYSTEM, "Describe this product.", ImageDescription,
                                    image=(data, content_type))
        except Exception as exc:
            log.warning("%s image description failed: %s", self.name, exc)
            return None
