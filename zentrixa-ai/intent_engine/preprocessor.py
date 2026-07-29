"""
intent_engine.preprocessor
==========================
Stateless transcript preprocessing — the FIRST step inside IntentEngine.classify().

Responsibilities
----------------
1. Whitespace cleanup  (strip, collapse duplicate spaces)
2. Lowercase
3. Punctuation cleanup
4. ASR correction mapping  (e.g. "tick zen" → "tickzen")
5. Noise / validity detection

Rules
-----
- ONLY rejects obviously unusable input (garbage, filler, repeated chars).
- NEVER determines whether a command is semantically valid.
- NEVER touches entity extraction or intent scoring.
- Returns PreprocessResult(valid, cleaned_text, reason).

All functions are pure (no side-effects, thread-safe).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_MIN_LENGTH: int = int(os.getenv("VALIDATION_MIN_LENGTH", "3"))

# ---------------------------------------------------------------------------
# ASR correction map  (moved here from normalizer.py)
# Maps common Whisper mis-hearings → canonical forms.
# Order matters: longer patterns first to avoid partial clobbers.
# ---------------------------------------------------------------------------

_ASR_CORRECTIONS: list[tuple[str, str]] = [
    # Project / app proper-nouns
    (r"\bvarta\s*lab(?:s)?\b",          "vartalap"),
    (r"\btick\s*zen\b",                  "tickzen"),
    (r"\bzen\s*trixa\b",                 "zentrixa"),
    (r"\bmed\s*track\s*fit\b",           "medtrackfit"),
    # Common verb mis-hearings
    (r"\b(?:prajet|crajet|prject|projeect|crate)\b", "create"),
    (r"\bcreat\b(?!\w)",                 "create"),  # "creat" without trailing chars
]

_ASR_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(pattern, re.IGNORECASE), replacement)
    for pattern, replacement in _ASR_CORRECTIONS
]

# ---------------------------------------------------------------------------
# Rejection patterns
# ---------------------------------------------------------------------------

# Strings made almost entirely of a single repeated character (e.g. "aaaaaaa")
_REPEATED_CHAR_RE = re.compile(r"^(.)\1{4,}$")

# Strings where the same word repeats ≥ 3 times (e.g. "yes yes yes yes")
_REPEATED_WORD_RE = re.compile(r"^(\w+)(?:\s+\1){2,}$", re.IGNORECASE)

# Punctuation-only strings (no alphabetic content)
_PUNCT_ONLY_RE = re.compile(r"^[^a-zA-Z]+$")

# Pure vocal hesitation fillers — only reject when ENTIRE transcript is these vocal sounds
_PURE_FILLERS: frozenset[str] = frozenset({
    "uh", "um", "umm", "hmm", "hm", "ah", "er", "uhh",
})

# Vowel regex to detect unreadable consonant gibberish
_VOWELS_RE = re.compile(r"[aeiouy]", re.IGNORECASE)

# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class PreprocessResult:
    valid:        bool
    cleaned_text: str
    reason:       str | None = None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def preprocess(text: str) -> PreprocessResult:
    """
    Validate and clean a raw transcript string.

    Validation Philosophy:
    - ONLY rejects obviously unusable garbage (empty, punctuation-only, repeated chars,
      repeated word patterns, vocal fillers, unreadable consonant gibberish).
    - NEVER rejects broken English, misrecognitions, incomplete sentences, or natural speech.
    """
    # ── Step 1: basic whitespace & strip ─────────────────────────────────────
    cleaned = _collapse_whitespace(text)

    # ── Step 2: empty or whitespace-only ──────────────────────────────────────
    if not cleaned:
        return PreprocessResult(valid=False, cleaned_text="",
                                reason="Empty or whitespace-only transcript.")

    # ── Step 3: no alphabetic or numeric content (punctuation/symbols only) ────
    if not re.search(r"[a-zA-Z0-9]", cleaned):
        return PreprocessResult(valid=False, cleaned_text=cleaned,
                                reason="Punctuation-only transcript.")

    # ── Step 4: lowercase ─────────────────────────────────────────────────────
    cleaned_lower = cleaned.lower()

    # ── Step 5: ASR correction mapping ───────────────────────────────────────
    cleaned_lower = _apply_asr_corrections(cleaned_lower)

    # ── Step 6: repeated single character noise (e.g. "aaaaaaa", "mmmmmm") ────
    no_spaces = cleaned_lower.replace(" ", "")
    if _REPEATED_CHAR_RE.match(no_spaces):
        return PreprocessResult(valid=False, cleaned_text=cleaned_lower,
                                reason="Repeated-character noise detected.")

    # ── Step 7: repeated word pattern (e.g. "ok ok ok ok", "hello hello hello")
    if _REPEATED_WORD_RE.match(cleaned_lower):
        return PreprocessResult(valid=False, cleaned_text=cleaned_lower,
                                reason="Repeated meaningless word pattern detected.")

    # ── Step 8: pure vocal hesitation fillers (e.g. "uh umm uh", "hmm") ───────
    tokens = cleaned_lower.split()
    if all(tok in _PURE_FILLERS for tok in tokens):
        return PreprocessResult(valid=False, cleaned_text=cleaned_lower,
                                reason=f"Vocal filler-only transcript: {cleaned_lower!r}")

    # ── Step 9: unreadable consonant gibberish (e.g. "bcdfghjklmnp") ──────────
    for tok in tokens:
        if len(tok) >= 7 and not _VOWELS_RE.search(tok):
            return PreprocessResult(valid=False, cleaned_text=cleaned_lower,
                                    reason="Unreadable gibberish noise detected.")

    return PreprocessResult(valid=True, cleaned_text=cleaned_lower)


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

def _collapse_whitespace(text: str) -> str:
    """Strip surrounding whitespace, normalize internal punctuation, and collapse internal runs."""
    if not text:
        return ""
    text = re.sub(r"[,;:!/]+", " ", text)
    text = text.strip(" \t\n\r\"'.,!?")
    return re.sub(r"\s{2,}", " ", text).strip()


def _apply_asr_corrections(text: str) -> str:
    """Apply ordered ASR correction patterns to text."""
    for pattern, replacement in _ASR_PATTERNS:
        text = pattern.sub(replacement, text)
    return text
