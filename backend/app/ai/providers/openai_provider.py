"""OpenAI adapter (Chat Completions with JSON-schema output, Embeddings, vision input).

Requires OPENAI_API_KEY. Not exercised by the automated test-suite (no credentials in CI); the
request/response handling is isolated here so it can be verified against the live API.
"""

from __future__ import annotations

import base64

import httpx
from pydantic import BaseModel

from app.ai.providers.base import AIProviderError
from app.ai.providers.llm_base import LLMProvider


class OpenAIProvider(LLMProvider):
    name = "openai"
    supports_vision = True

    def __init__(self, api_key: str, base_url: str, chat_model: str, embedding_model: str, dimensions: int,
                 timeout: float = 30.0) -> None:
        super().__init__(dimensions)
        self.chat_model = chat_model
        self.embedding_model = embedding_model
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )

    def _complete_json(self, system: str, user: str, schema: type[BaseModel], image: tuple[bytes, str] | None = None) -> str:
        content: list[dict] | str = user
        if image:
            data, ctype = image
            url = f"data:{ctype};base64,{base64.b64encode(data).decode()}"
            content = [{"type": "text", "text": user}, {"type": "image_url", "image_url": {"url": url}}]
        body = {
            "model": self.chat_model,
            "temperature": 0.1,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": schema.__name__, "schema": schema.model_json_schema(), "strict": False},
            },
        }
        resp = self._client.post("/chat/completions", json=body)
        if resp.status_code >= 400:
            raise AIProviderError(f"OpenAI error {resp.status_code}: {resp.text[:300]}")
        return resp.json()["choices"][0]["message"]["content"]

    def embed(self, texts: list[str]) -> list[list[float]]:
        resp = self._client.post(
            "/embeddings",
            json={"model": self.embedding_model, "input": texts, "dimensions": self.embedding_dimensions},
        )
        if resp.status_code >= 400:
            raise AIProviderError(f"OpenAI embeddings error {resp.status_code}: {resp.text[:300]}")
        data = sorted(resp.json()["data"], key=lambda d: d["index"])
        return [d["embedding"] for d in data]
