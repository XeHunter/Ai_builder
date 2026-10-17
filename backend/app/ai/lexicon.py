"""Grocery-domain lexicon and text normalisation shared by search, list parsing and the demo provider.

This is deliberately small and explicit: it is used for deterministic matching and for the
hashed lexical embeddings of the demo provider. It is *not* a language model.
"""

from __future__ import annotations

import re
import unicodedata

STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with", "some", "any", "me", "my", "i",
    "need", "want", "get", "buy", "find", "please", "show", "looking", "look", "can", "you", "is", "are",
    "there", "do", "does", "have", "has", "where", "which", "what", "this", "that", "these", "those", "it",
    "items", "item", "things", "stuff", "under", "below", "within", "less", "than", "people", "person",
    "us", "we", "our", "would", "like", "also", "few", "pack", "packs", "goes", "go", "good", "best", "be",
    "rs", "inr", "rupees", "budget", "around", "about", "store", "shop", "aisle", "two", "three", "four",
}

# canonical term -> synonyms / closely related surface forms
SYNONYMS: dict[str, list[str]] = {
    "milk": ["doodh", "dairy milk carton", "toned milk", "full cream"],
    "eggs": ["egg", "anda", "dozen eggs"],
    "bread": ["loaf", "pav", "sandwich bread"],
    "detergent": ["washing powder", "laundry", "surf", "washing liquid"],
    "diapers": ["diaper", "nappies", "nappy", "diaper pants", "baby pants"],
    "chocolate": ["choco", "cocoa bar", "candy bar"],
    "coffee": ["instant coffee", "filter coffee", "kaapi"],
    "tea": ["chai", "tea leaves", "green tea"],
    "toothpaste": ["tooth paste", "dental cream"],
    "umbrella": ["umbrellas", "brolly"],
    "camera": ["dslr", "vlog camera", "cameras"],
    "memory card": ["sd card", "sdxc", "micro sd", "microsd", "storage card"],
    "smart watch": ["smartwatch", "fitness watch", "watch"],
    "butter": ["makhan"],
    "curd": ["dahi", "yogurt", "yoghurt"],
    "rice": ["basmati", "chawal"],
    "flour": ["atta", "wheat flour"],
    "oil": ["cooking oil", "sunflower oil"],
    "biscuits": ["biscuit", "cookies"],
    "chips": ["crisps", "wafers"],
    "juice": ["orange juice", "fruit juice"],
    "cereal": ["cornflakes", "corn flakes", "muesli", "oats"],
    "jam": ["fruit jam", "spread"],
    "shampoo": ["hair wash"],
    "soap": ["bath soap", "body soap"],
    "dishwash": ["dish wash", "dishwashing", "vim"],
    "ice cream": ["icecream"],
    "charger": ["power adapter", "fast charger"],
    "raincoat": ["rain coat", "rain jacket"],
}

# Occasion -> ordered shopping "slots" (search phrases) used by the budget basket builder.
OCCASIONS: dict[str, list[str]] = {
    "breakfast": ["milk", "bread", "eggs", "butter", "jam", "cereal", "coffee", "bananas"],
    "tea time": ["tea", "milk", "biscuits", "sugar"],
    "baby": ["diapers", "baby wipes"],
    "cleaning": ["detergent", "dishwash", "toilet cleaner"],
    "rainy day": ["umbrella", "raincoat", "hot chocolate", "tea"],
    "party": ["chips", "cola", "chocolate", "ice cream"],
    "photography": ["camera", "memory card", "camera bag"],
}

UNITS = {
    "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg", "g": "g", "gm": "g", "gms": "g", "grams": "g",
    "l": "l", "litre": "l", "litres": "l", "liter": "l", "liters": "l", "ltr": "l", "ml": "ml",
    "pc": "pc", "pcs": "pc", "piece": "pc", "pieces": "pc", "dozen": "dozen", "pack": "pack", "packs": "pack",
    "packet": "pack", "packets": "pack", "bottle": "bottle", "bottles": "bottle", "box": "box", "boxes": "box",
    "loaf": "loaf", "loaves": "loaf", "carton": "carton", "cartons": "carton", "x": "x",
}

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "a couple of": 2, "couple of": 2, "half": 0.5, "a": 1, "an": 1,
}

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", text.lower()).strip()


def stem(token: str) -> str:
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 4 and token.endswith(("ches", "shes", "sses", "xes")):
        return token[:-2]
    if len(token) > 3 and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def tokens(text: str, drop_stopwords: bool = True) -> list[str]:
    out = []
    for t in _TOKEN_RE.findall(normalize(text)):
        if drop_stopwords and t in STOPWORDS:
            continue
        out.append(stem(t))
    return out


def expand_query(text: str) -> str:
    """Append canonical terms for any synonym found (e.g. 'nappies' -> 'diapers')."""
    norm = normalize(text)
    extra: list[str] = []
    for canonical, alts in SYNONYMS.items():
        if canonical in norm:
            continue
        for alt in alts:
            if re.search(rf"\b{re.escape(alt)}\b", norm):
                extra.append(canonical)
                break
    return norm if not extra else f"{norm} {' '.join(extra)}"
