"""AI provider interface.

Services depend on ``AIProvider`` only. Each provider implements the same task-level methods so that
LLM-backed providers and the deterministic ``DemoProvider`` are interchangeable. Providers never touch
the database: they turn text into validated structures, and services decide what to do with them.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.ai.schemas import ComposedReply, ImageDescription, ParsedList, ShoppingIntent


class AIProviderError(RuntimeError):
    pass


class AIProvider(ABC):
    name: str = "base"
    kind: str = "llm"  # llm|deterministic
    chat_model: str = ""
    embedding_model: str = ""
    embedding_dimensions: int = 256
    supports_vision: bool = False

    @abstractmethod
    def extract_intent(self, message: str, *, context_product: str | None = None) -> ShoppingIntent: ...

    @abstractmethod
    def parse_shopping_list(self, text: str) -> ParsedList: ...

    @abstractmethod
    def compose_reply(self, *, user_message: str, intent: ShoppingIntent, facts: dict) -> ComposedReply: ...

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]: ...

    def describe_image(self, data: bytes, content_type: str) -> ImageDescription | None:
        return None

    def info(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "chat_model": self.chat_model,
            "embedding_model": self.embedding_model,
            "embedding_dimensions": self.embedding_dimensions,
            "supports_vision": self.supports_vision,
        }
