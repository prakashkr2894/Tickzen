"""
intent_engine.normalizer
========================
Text normalisation and fuzzy-matching helpers.

All functions are pure (no side-effects, thread-safe).

Note: ASR correction mapping has been moved to intent_engine.preprocessor.
"""

from __future__ import annotations

import re
from functools import lru_cache


# ---------------------------------------------------------------------------
# Filler words — stripped ONLY for intent matching (never for entity extraction)
# ---------------------------------------------------------------------------

_FILLERS = frozenset({
    "um", "uh", "like", "you know", "so", "well", "basically",
    "literally", "actually", "okay", "ok", "right", "please",
    "hey", "zentrixa", "could you", "can you", "i want to",
    "i need to", "i would like to", "would you", "go ahead and",
    "just", "quickly", "now", "also",
})

_FILLER_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(f) for f in sorted(_FILLERS, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)

_WHITESPACE_RE = re.compile(r"\s{2,}")


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    """
    Collapse whitespace, replace internal punctuation (commas, semicolons, colons)
    with spaces, and strip surrounding punctuation.
    Applied to ALL text before entity extraction and before matching.
    """
    if not text:
        return ""
    cleaned = re.sub(r"[,;:!/]+", " ", text)
    return _WHITESPACE_RE.sub(" ", cleaned.strip(" \t\n\r\"'.,!?")).strip()


def normalize_for_matching(text: str) -> str:
    """
    Strip filler words, lowercase, collapse whitespace.

    Used ONLY for intent matching — never for entity extraction,
    because stripping fillers can remove parts of the entity name.
    """
    cleaned = _FILLER_RE.sub(" ", text.lower())
    return _WHITESPACE_RE.sub(" ", cleaned).strip()


def strip_leading_articles(value: str) -> str:
    """Remove leading determiners (the / a / an / my / this / that)."""
    return re.sub(r"^(the|a|an|my|this|that)\s+", "", value, flags=re.I).strip()


# ---------------------------------------------------------------------------
# Fuzzy matching
# ---------------------------------------------------------------------------

def fuzzy_ratio(a: str, b: str) -> float:
    """
    Simple character-level similarity in [0, 1].

    Uses rapidfuzz if available (faster); falls back to SequenceMatcher.
    """
    if not a or not b:
        return 0.0
    try:
        from rapidfuzz import fuzz  # type: ignore[import]
        return fuzz.ratio(a.lower(), b.lower()) / 100.0
    except ImportError:
        from difflib import SequenceMatcher
        return SequenceMatcher(None, a.lower(), b.lower()).ratio()


@lru_cache(maxsize=512)
def fuzzy_word_match(word: str, candidates: tuple[str, ...], threshold: float = 0.65) -> str | None:
    """
    Return the first candidate whose fuzzy ratio to *word* is >= threshold.
    Results are LRU-cached (512 entries) so repeated calls are free.
    """
    for candidate in candidates:
        if fuzzy_ratio(word, candidate) >= threshold:
            return candidate
    return None


def text_contains_any(text: str, words: tuple[str, ...]) -> bool:
    """
    True if *text* contains any of *words* as a whole word (case-insensitive).
    Falls back to fuzzy matching if exact match fails, enforcing strict word length filters
    to prevent short words (e.g. "it") from matching longer nouns (e.g. "item").
    """
    for word in words:
        if " " in word:
            # Multi-word phrase — substring match
            if word.lower() in text.lower():
                return True
        else:
            if re.search(rf"\b{re.escape(word)}\b", text, re.IGNORECASE):
                return True
            # Length-filtered fuzzy fallback on individual tokens (catches ASR noise)
            tokens = text.lower().split()
            for token in tokens:
                if min(len(token), len(word)) >= 3 and abs(len(token) - len(word)) <= 2:
                    if fuzzy_ratio(token, word) >= 0.70:
                        return True
    return False
