"""Deterministic provider used when no LLM API key is configured (the default demo mode).

* Intent extraction: keyword/regex rules over the grocery lexicon.
* Shopping-list parsing: delimiter splitting plus quantity/unit grammar.
* Replies: templates filled only with backend-verified facts.
* Embeddings: feature-hashed word unigrams + character trigrams ("lexical embeddings"). These capture
  spelling and synonym overlap, not real semantics, and are labelled as such in the API.
"""

from __future__ import annotations

import hashlib
import math
import re

from app.ai import lexicon
from app.ai.providers.base import AIProvider
from app.ai.schemas import ComposedReply, ParsedList, ParsedListItem, ShoppingIntent

_BUDGET_RE = re.compile(r"(?:under|below|within|less than|upto|up to|max(?:imum)?|budget(?: of)?)\s*(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)", re.I)
_CURRENCY_RE = re.compile(r"(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)", re.I)
_PEOPLE_RE = re.compile(r"(?:for\s+)?(\d+|one|two|three|four|five|six)\s+(?:people|persons|adults|of us|guests)", re.I)
_PEOPLE_FOR_RE = re.compile(r"\bfor\s+(two|three|four|five|six|\d+)\b", re.I)
_LOCATE_RE = re.compile(r"\b(where (?:can i find|is|are|do (?:i|you) (?:find|keep))|which aisle|location of|find the aisle)\b", re.I)
_COMPLEMENT_RE = re.compile(r"\b(compatible|go(?:es)? (?:well )?with|go(?:es)? well|accessor(?:y|ies)|complement\w*|pair(?:s)? with|works? with|need with)\b", re.I)
_SIMILAR_RE = re.compile(r"\b(similar|like this|alternatives?|instead of|substitutes?|cheaper options?|same as)\b", re.I)
_GREETING_RE = re.compile(r"^\s*(hi|hello|hey|namaste|good (?:morning|evening|afternoon))\b[\s!.]*$", re.I)
_LIST_SPLIT_RE = re.compile(r"[,\n;]+|\.\s+|\s+and\s+|\s+&\s+|\s*\+\s*")
_QTY_RE = re.compile(
    r"^\s*(?P<qty>\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|half|a couple of|couple of)?\s*"
    r"(?P<unit>kgs?|kilos?|g|gms?|grams|l|litres?|liters?|ltr|ml|pcs?|pieces?|dozen|packs?|packets?|bottles?|"
    r"box(?:es)?|loaf|loaves|cartons?)?\s*(?:x\s*|of\s+)?(?P<rest>.+?)\s*(?:x\s*(?P<qty2>\d+))?\s*$",
    re.I,
)
_VAGUE = {"one", "ones", "product", "products", "item", "thing", "similar", "same", "else", "something"}
_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


def _to_number(token: str | None) -> float | None:
    if not token:
        return None
    t = token.lower()
    if t in lexicon.NUMBER_WORDS:
        return float(lexicon.NUMBER_WORDS[t])
    try:
        return float(t)
    except ValueError:
        return None


class DemoProvider(AIProvider):
    name = "demo"
    kind = "deterministic"
    chat_model = "rules-v1"
    embedding_model = "demo-hash-lexical-v1"

    def __init__(self, dimensions: int = 256) -> None:
        self.embedding_dimensions = dimensions

    # -- intent -------------------------------------------------------------
    def extract_intent(self, message: str, *, context_product: str | None = None) -> ShoppingIntent:
        text = message.strip()
        norm = lexicon.normalize(text)
        if not norm:
            return ShoppingIntent(intent="clarify", clarifying_question="What are you shopping for today?")
        if _GREETING_RE.match(text):
            return ShoppingIntent(intent="greeting")

        budget = None
        if m := _BUDGET_RE.search(text) or _CURRENCY_RE.search(text):
            budget = float(m.group(1))
        people = None
        if m := _PEOPLE_RE.search(text) or _PEOPLE_FOR_RE.search(text):
            raw = m.group(1).lower()
            people = int(raw) if raw.isdigit() else _NUM_WORDS.get(raw)

        occasion = next((o for o in lexicon.OCCASIONS if o in norm), None)
        if occasion is None and re.search(r"\brain(y|ing)?\b|monsoon", norm):
            occasion = "rainy day"

        cleaned = _BUDGET_RE.sub(" ", text)
        cleaned = _CURRENCY_RE.sub(" ", cleaned)
        cleaned = _PEOPLE_RE.sub(" ", cleaned)
        cleaned = _PEOPLE_FOR_RE.sub(" ", cleaned)

        if _LOCATE_RE.search(text):
            phrase = _LOCATE_RE.split(cleaned)[-1]
            queries = self._phrases(phrase)
            if not queries and context_product:
                queries = [context_product]
            if not queries:
                return ShoppingIntent(intent="clarify", clarifying_question="Which product are you looking for?")
            return ShoppingIntent(intent="locate_product", search_queries=queries)

        if _COMPLEMENT_RE.search(text):
            ref = self._reference_after(cleaned, ("with", "for", "to")) or context_product
            # what the shopper wants: the text minus trigger words and the reference phrase
            rest = _COMPLEMENT_RE.sub(" ", cleaned)
            rest = re.split(r"(?:with|for|to)", lexicon.normalize(rest))[0]
            ref_words = set((ref or "").split())
            target = []
            for t in self._phrases(rest):
                words = [w for w in t.split() if w not in ref_words and w not in _VAGUE]
                if words:
                    target.append(" ".join(words))
            if not ref and not target:
                return ShoppingIntent(
                    intent="clarify",
                    clarifying_question="Which product would you like a compatible or complementary item for?",
                )
            return ShoppingIntent(
                intent="complementary",
                reference_product=ref or (target[0] if target else None),
                search_queries=[q for q in target if q != ref][:3],
            )

        if _SIMILAR_RE.search(text):
            ref = self._reference_after(cleaned, ("to", "of", "like")) or context_product
            if not ref:
                phrases = [ph for ph in self._phrases(_SIMILAR_RE.sub(" ", cleaned))
                           if set(ph.split()) - _VAGUE]
                ref = phrases[0] if phrases else None
            if not ref:
                return ShoppingIntent(
                    intent="clarify",
                    clarifying_question="Which product should I find alternatives for? You can also upload a photo.",
                )
            return ShoppingIntent(intent="similar_product", reference_product=ref)

        if occasion and (budget is not None or people is not None or "items" in norm):
            return ShoppingIntent(intent="budget_basket", occasion=occasion, budget=budget, people=people)

        queries = self._phrases(cleaned)
        if occasion and not queries:
            return ShoppingIntent(intent="budget_basket", occasion=occasion, budget=budget, people=people)
        if not queries:
            return ShoppingIntent(
                intent="clarify",
                clarifying_question="Could you tell me which products or what occasion you are shopping for?",
            )
        return ShoppingIntent(
            intent="find_products", search_queries=queries[:8], budget=budget, people=people, occasion=occasion,
            max_unit_price=budget if budget is not None and len(queries) == 1 else None,
        )

    @staticmethod
    def _reference_after(text: str, preps: tuple[str, ...]) -> str | None:
        norm = lexicon.normalize(text)
        for prep in preps:
            m = re.search(rf"\b{prep}\s+(?:this|my|the|a|an)?\s*([a-z0-9][a-z0-9 \-]+)", norm)
            if m:
                phrase = " ".join(t for t in m.group(1).split() if t not in lexicon.STOPWORDS and t not in _VAGUE)
                phrase = phrase.strip(" ?.!")
                if phrase:
                    return phrase
        return None

    @staticmethod
    def _phrases(text: str) -> list[str]:
        parts = [p for p in _LIST_SPLIT_RE.split(lexicon.normalize(text)) if p]
        out: list[str] = []
        for p in parts:
            words = [w for w in re.findall(r"[a-z0-9\-]+", p) if w not in lexicon.STOPWORDS and not w.isdigit()]
            phrase = " ".join(words).strip()
            if phrase and phrase not in out:
                out.append(phrase)
        return out

    # -- shopping list ------------------------------------------------------
    def parse_shopping_list(self, text: str) -> ParsedList:
        items: list[ParsedListItem] = []
        for raw in _LIST_SPLIT_RE.split(text):
            chunk = raw.strip(" .!?-*•\t")
            if not chunk:
                continue
            chunk = re.sub(r"^\s*(?:i need|need|buy|get|also|and)\s+", "", chunk, flags=re.I)
            m = _QTY_RE.match(chunk)
            qty, unit, name = 1.0, None, chunk
            if m:
                name = (m.group("rest") or chunk).strip()
                q = _to_number(m.group("qty")) or _to_number(m.group("qty2"))
                if q:
                    qty = q
                if m.group("unit"):
                    unit = lexicon.UNITS.get(m.group("unit").lower(), m.group("unit").lower())
            if unit == "dozen":
                qty, unit = qty * 12, "pc"
            name = re.sub(r"\s+", " ", name).strip(" .")
            if name:
                items.append(ParsedListItem(text=name[:160], quantity=min(qty, 1000), unit=unit))
        return ParsedList(items=items[:100])

    # -- replies ------------------------------------------------------------
    def compose_reply(self, *, user_message: str, intent: ShoppingIntent, facts: dict) -> ComposedReply:
        products = facts.get("products", [])
        comps = facts.get("complementary", [])
        store = facts.get("store_name")
        ids = [p["id"] for p in products[:5]]
        if intent.intent == "greeting":
            return ComposedReply(
                message="Hi! Tell me what you need — for example \"breakfast for two under ₹500\", "
                "\"where is the milk?\" or \"which memory card fits my camera?\""
            )
        if intent.intent == "clarify":
            return ComposedReply(message=intent.clarifying_question or "Could you tell me a bit more?")
        if not products and not comps:
            missing = ", ".join(facts.get("unmatched", [])) or "that"
            return ComposedReply(
                message=f"I couldn't find {missing} in the {store or 'selected store'} catalog. "
                "Try a different name or browse the categories."
            )
        if intent.intent == "budget_basket":
            b = facts.get("basket", {})
            line = f"Here is a {intent.occasion or 'shopping'} basket"
            if intent.people:
                line += f" for {intent.people}"
            line += f" totalling ₹{b.get('total', 0):.0f}"
            if b.get("budget") is not None:
                line += (
                    f", within your ₹{b['budget']:.0f} budget." if b.get("within_budget")
                    else f". I couldn't fit everything within ₹{b['budget']:.0f}; the essentials are listed first."
                )
            else:
                line += "."
            skipped = b.get("skipped", [])
            if skipped:
                line += f" Left out to stay on budget: {', '.join(skipped)}."
            return ComposedReply(message=line, highlight_product_ids=ids)
        if intent.intent == "locate_product":
            lines = []
            for p in products[:3]:
                loc = p.get("location")
                if loc:
                    lines.append(f"{p['name']} is in {loc['aisle_label']} ({loc['shelf_code']}).")
                else:
                    lines.append(f"{p['name']} has no recorded shelf location at this store yet.")
            return ComposedReply(message=" ".join(lines), highlight_product_ids=ids)
        if intent.intent == "complementary":
            ref = facts.get("reference")
            if comps and ref:
                names = ", ".join(c["name"] for c in comps[:3])
                why = comps[0].get("reason", "")
                return ComposedReply(
                    message=f"For the {ref['name']}, consider: {names}. {why}".strip(),
                    highlight_product_ids=[c["id"] for c in comps[:3]],
                )
            return ComposedReply(
                message="I found the product but no recorded compatible or frequently co-purchased items yet.",
                highlight_product_ids=ids,
            )
        if intent.intent == "similar_product":
            ref = facts.get("reference")
            head = f"Alternatives to {ref['name']}:" if ref else "Similar products:"
            return ComposedReply(message=f"{head} " + ", ".join(p["name"] for p in products[:4]) + ".",
                                 highlight_product_ids=ids)
        names = ", ".join(f"{p['name']} (₹{p['price']:.0f})" for p in products[:4])
        msg = f"I found {len(products)} matching product{'s' if len(products) != 1 else ''}: {names}."
        out_of_stock = [p["name"] for p in products if not p.get("in_stock")]
        if out_of_stock:
            msg += f" Currently out of stock: {', '.join(out_of_stock[:3])}."
        if facts.get("unmatched"):
            msg += f" No match for: {', '.join(facts['unmatched'])}."
        return ComposedReply(message=msg, highlight_product_ids=ids)

    # -- embeddings -----------------------------------------------------------
    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._hash_embed(t) for t in texts]

    def _hash_embed(self, text: str) -> list[float]:
        dims = self.embedding_dimensions
        vec = [0.0] * dims
        expanded = lexicon.expand_query(text)
        feats: list[tuple[str, float]] = [(f"w:{t}", 1.0) for t in lexicon.tokens(expanded)]
        compact = re.sub(r"[^a-z0-9]", "", lexicon.normalize(expanded))
        feats += [(f"c:{compact[i:i + 3]}", 0.35) for i in range(max(0, len(compact) - 2))]
        for feat, weight in feats:
            h = int.from_bytes(hashlib.blake2b(feat.encode(), digest_size=8).digest(), "little")
            idx = h % dims
            sign = 1.0 if (h >> 63) & 1 else -1.0
            vec[idx] += sign * weight
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]
