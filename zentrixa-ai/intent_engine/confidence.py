"""
intent_engine.confidence
========================
Five-signal confidence scoring system.

Signals and their weights
-------------------------
1. Verb match         0.35  — exact or synonym match against intent verbs
2. Entity/noun match  0.25  — required noun present in text (task, project, …)
3. Entity extracted   0.20  — named entity actually found (not just the noun word)
4. Fuzzy verb match   0.10  — rapidfuzz ratio ≥ 0.82 on any token
5. Grammar quality    0.10  — word count 2-20, no garbage characters

confidence = Σ(signal_i × weight_i),  clamped to [0.0, 1.0]
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from intent_engine.normalizer import fuzzy_ratio, text_contains_any


# ---------------------------------------------------------------------------
# Signal weights (must sum to 1.0)
# ---------------------------------------------------------------------------

W_VERB_EXACT    = 0.35
W_ENTITY_NOUN   = 0.25
W_ENTITY_VALUE  = 0.20
W_FUZZY_VERB    = 0.10
W_GRAMMAR       = 0.10

assert abs(W_VERB_EXACT + W_ENTITY_NOUN + W_ENTITY_VALUE + W_FUZZY_VERB + W_GRAMMAR - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

@dataclass
class ConfidenceBreakdown:
    verb_exact:    float  # 0 or 1
    entity_noun:   float  # 0 or 1
    entity_value:  float  # 0 or 1
    fuzzy_verb:    float  # 0 … 1
    grammar:       float  # 0 … 1
    score:         float  # weighted total


# ---------------------------------------------------------------------------
# Scorer
# ---------------------------------------------------------------------------

class ConfidenceScorer:
    """
    Stateless scorer.  Call score() with the matched intent definition
    and the normalised text (filler-stripped, lowercased).
    """

    @staticmethod
    def score(
        *,
        normalised_text: str,           # filler-stripped, lowercased
        original_text:   str,           # used for entity extraction check
        verbs:           tuple[str, ...],
        synonyms:        tuple[str, ...],
        entity_nouns:    tuple[str, ...],
        extracted:       dict,          # result from EntityExtractor.extract()
    ) -> ConfidenceBreakdown:
        """Compute all five signals and return a ConfidenceBreakdown."""

        # ── Signal 1: exact / synonym verb match ──────────────────────────
        all_verbs  = verbs + synonyms
        verb_hit   = 1.0 if text_contains_any(normalised_text, all_verbs) else 0.0

        # ── Signal 2: entity noun present ─────────────────────────────────
        noun_hit   = 1.0 if text_contains_any(normalised_text, entity_nouns) else 0.0

        # ── Signal 3: at least one entity value extracted ──────────────────
        # For view/navigation intents (no named entity to extract), we give
        # a partial score when the entity noun match is strong (signal 2 = 1.0),
        # so these intents are not permanently penalised by having nothing to extract.
        value_hit  = 1.0 if extracted else (0.75 if noun_hit == 1.0 else 0.0)

        # ── Signal 4: fuzzy verb match (catches typos) ────────────────────
        tokens     = normalised_text.split()
        best_fuzzy = 0.0
        for token in tokens:
            for verb in all_verbs:
                r = fuzzy_ratio(token, verb)
                if r > best_fuzzy:
                    best_fuzzy = r
        fuzzy_hit  = max(0.0, (best_fuzzy - 0.50) / 0.50)   # 0 below 0.50, 1.0 at exact match

        # ── Signal 5: grammar quality ─────────────────────────────────────
        word_count = len(tokens)
        if 2 <= word_count <= 20:
            grammar = 1.0
        elif word_count < 2:
            grammar = 0.2
        else:
            grammar = max(0.0, 1.0 - (word_count - 20) * 0.03)

        # Penalise garbage (mostly non-alpha chars)
        alpha_ratio = len(re.findall(r"[a-z]", normalised_text)) / max(len(normalised_text), 1)
        if alpha_ratio < 0.5:
            grammar *= 0.3

        # ── Weighted total ─────────────────────────────────────────────────
        score = (
            verb_hit   * W_VERB_EXACT  +
            noun_hit   * W_ENTITY_NOUN +
            value_hit  * W_ENTITY_VALUE +
            fuzzy_hit  * W_FUZZY_VERB  +
            grammar    * W_GRAMMAR
        )
        score = round(min(max(score, 0.0), 1.0), 4)

        return ConfidenceBreakdown(
            verb_exact   = verb_hit,
            entity_noun  = noun_hit,
            entity_value = value_hit,
            fuzzy_verb   = round(fuzzy_hit, 4),
            grammar      = round(grammar, 4),
            score        = score,
        )
