# ADR-0004: AI provider abstraction with a deterministic default

* Status: accepted
* Date: 2026-10-16

## Context
The product must run with no paid API keys, must never let a model invent inventory, prices or
locations, and should support OpenAI or Gemini when configured.

## Decision
`AIProvider` exposes task-level methods (`extract_intent`, `parse_shopping_list`, `compose_reply`,
`embed`, `describe_image`). `DemoProvider` implements them with rules, a grocery lexicon and hashed
lexical embeddings. `LLMProvider` (OpenAI/Gemini) asks for JSON matching Pydantic schemas, validates
the output, and falls back to the demo implementation on any failure (reported as `fell_back`).
The assistant service executes tools itself (catalog search, stock, price, location, curated
relations, mined rules) and passes only *verified facts* to the reply composer; replies whose product
IDs or rupee amounts are not in the facts are replaced by the deterministic template.

## Consequences
* Demo mode is fully functional and honest about what it is (`provider.kind = deterministic`).
* LLMs can improve language understanding and phrasing without being able to change state or
  fabricate data.
* OpenAI/Gemini adapters are not exercised in CI (no credentials) and must be smoke-tested with keys.
