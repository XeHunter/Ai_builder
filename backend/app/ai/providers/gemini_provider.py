"""Google Gemini adapter (generateContent with JSON output, batchEmbedContents, inline image input).

Requires GEMINI_API_KEY. The key is sent in the ``x-goog-api-key`` header, never in URLs/logs.
Not exercised by the automated test-suite (no credentials in CI).
"""

from __future__ import annotations

import base64
import json
import time

import httpx
from pydantic import BaseModel

from app.ai.providers.base import AIProviderError
from app.ai.providers.llm_base import LLMProvider


class GeminiProvider(LLMProvider):
    name = "gemini"
    supports_vision = True

    def __init__(self, api_key: str, base_url: str, chat_model: str, embedding_model: str, dimensions: int,
                 timeout: float = 30.0) -> None:
        super().__init__(dimensions)
        self.chat_model = chat_model
        self.embedding_model = embedding_model
        self._thinking_supported = True
        self._client = httpx.Client(base_url=base_url.rstrip("/"), headers={"x-goog-api-key": api_key}, timeout=timeout)

    def _complete_json(self, system: str, user: str, schema: type[BaseModel], image: tuple[bytes, str] | None = None) -> str:
        parts: list[dict] = [{"text": f"{user}\n\nJSON schema:\n{json.dumps(schema.model_json_schema())}"}]
        if image:
            data, ctype = image
            parts.append({"inline_data": {"mime_type": ctype, "data": base64.b64encode(data).decode()}})
        config: dict = {"temperature": 0.1, "responseMimeType": "application/json"}
        if self._thinking_supported:
            # These are short structured tasks: low reasoning effort keeps latency well under a second or two.
            config["thinkingConfig"] = {"thinkingLevel": "low"}
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": config,
        }
        resp = self._client.post(f"/models/{self.chat_model}:generateContent", json=body)
        if resp.status_code == 400 and self._thinking_supported and "thinking" in resp.text.lower():
            # Model doesn't accept a thinking level: remember that and retry without it.
            self._thinking_supported = False
            body["generationConfig"].pop("thinkingConfig", None)
            resp = self._client.post(f"/models/{self.chat_model}:generateContent", json=body)
        if resp.status_code >= 400:
            raise AIProviderError(f"Gemini error {resp.status_code}: {resp.text[:300]}")
        try:
            cand = resp.json()["candidates"][0]
            # Newer models may split the answer over several parts and add thought parts; keep the answer text.
            text = "".join(p.get("text", "") for p in cand["content"]["parts"] if not p.get("thought"))
        except (KeyError, IndexError) as exc:
            raise AIProviderError(f"Gemini returned no content: {resp.text[:300]}") from exc
        if not text.strip():
            raise AIProviderError(f"Gemini returned an empty answer (finishReason={cand.get('finishReason')})")
        return text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()

    def embed(self, texts: list[str]) -> list[list[float]]:
        model = f"models/{self.embedding_model}"
        body = {
            "requests": [
                {"model": model, "content": {"parts": [{"text": t}]}, "outputDimensionality": self.embedding_dimensions}
                for t in texts
            ]
        }
        if time.monotonic() < self._cooldown_until:
            raise AIProviderError("gemini is cooling down after a recent timeout or quota error")
        try:
            resp = self._client.post(f"/{model}:batchEmbedContents", json=body)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            self._cooldown_until = time.monotonic() + self.COOLDOWN_SECONDS
            raise AIProviderError(f"Gemini embeddings unreachable: {exc}") from exc
        if resp.status_code >= 400:
            if resp.status_code in (402, 429, 500, 503):
                self._cooldown_until = time.monotonic() + self.COOLDOWN_SECONDS
            raise AIProviderError(f"Gemini embeddings error {resp.status_code}: {resp.text[:300]}")
        return [e["values"] for e in resp.json()["embeddings"]]
