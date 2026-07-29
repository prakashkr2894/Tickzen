"""
intent_engine.entity_quality
=============================
Dedicated Entity Quality Validation layer inside IntentEngine.

Responsibilities
----------------
1. Validate extracted entity strings (e.g. project_name, title, workspace_name).
2. Detect repeated token loops (e.g. "name name name name", "hello hello hello").
3. Calculate lexical diversity ratio (unique words / total words).
4. Detect stop-word domination (e.g. "the and with").
5. Detect STT artifacts, placeholder nouns, and single-word reserved noise.
6. Support legitimate repeated business names (e.g. "New New York", "Very Very Good").
7. Pure, generic, stateless validator — works across all entity types.

Returns
-------
EntityQualityResult(valid: bool, score: float, reason: str | None)
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Single-word placeholder / noise entity reserved list
_RESERVED_PLACEHOLDERS: frozenset[str] = frozenset({
    "name", "named", "called", "title", "titled", "project", "workspace",
    "task", "ticket", "issue", "repo", "repository", "it", "thing", "stuff",
    "something", "whatever", "null", "undefined", "untitled", "unknown",
})

# Common filler/stop words for stop-word domination check
_STOP_WORDS: frozenset[str] = frozenset({
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "over", "after",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "this", "that", "these", "those", "my", "your",
    "his", "her", "its", "our", "their", "it", "which", "who", "what", "where",
})


@dataclass
class EntityQualityResult:
    valid:  bool
    score:  float
    reason: str | None = None


class EntityQualityValidator:
    """
    Generic, intent-agnostic Entity Quality Validator.
    Validates any extracted entity string for realistic quality.
    """

    @classmethod
    def validate(cls, entity_name: str, value: str) -> EntityQualityResult:
        if not value or not isinstance(value, str):
            return EntityQualityResult(
                valid=False, score=0.0, reason="Entity value is empty or invalid type."
            )

        cleaned = value.strip().lower()
        if not cleaned:
            return EntityQualityResult(
                valid=False, score=0.0, reason="Entity value is whitespace only."
            )

        tokens = cleaned.split()
        total_tokens = len(tokens)

        # ── 1. Reserved Single-Word Placeholder Check ──────────────────────
        if total_tokens == 1 and cleaned in _RESERVED_PLACEHOLDERS:
            reason = f"Reserved placeholder word '{cleaned}' cannot be a valid entity."
            cls._log_quality(entity_name, value, 0.0, reason, "FAIL")
            return EntityQualityResult(valid=False, score=0.0, reason=reason)

        # ── 2. Repeated Word Check ──────────────────────────────────────────
        # E.g. "name name name name", "hello hello hello hello"
        word_counts: dict[str, int] = {}
        for tok in tokens:
            word_counts[tok] = word_counts.get(tok, 0) + 1

        most_frequent_count = max(word_counts.values()) if word_counts else 0

        if total_tokens >= 3:
            most_freq_word = max(word_counts, key=lambda k: word_counts[k])
            # Flag if >= 3 occurrences of any word (e.g. "name name name name", "test test test")
            # OR if 2 occurrences in 3 words AND the word is a placeholder/stop word (e.g. "name name project", "uh uh task")
            if most_frequent_count >= 3 or (most_frequent_count >= 2 and (most_freq_word in _RESERVED_PLACEHOLDERS or most_freq_word in _STOP_WORDS)):
                reason = f"Repeated token '{most_freq_word}' detected ({most_frequent_count}/{total_tokens} occurrences)."
                cls._log_quality(entity_name, value, 0.0, reason, "FAIL")
                return EntityQualityResult(valid=False, score=0.0, reason=reason)
        elif total_tokens == 2:
            # For 2-word entities, e.g. "name name" vs "new new"
            if tokens[0] == tokens[1] and (tokens[0] in _RESERVED_PLACEHOLDERS or tokens[0] in _STOP_WORDS):
                reason = f"Repeated placeholder token '{tokens[0]}' detected."
                cls._log_quality(entity_name, value, 0.0, reason, "FAIL")
                return EntityQualityResult(valid=False, score=0.0, reason=reason)

        # ── 3. Lexical Diversity Ratio ──────────────────────────────────────
        # Unique Words / Total Words
        unique_tokens = len(set(tokens))
        lexical_diversity = unique_tokens / total_tokens if total_tokens > 0 else 1.0

        if total_tokens >= 3 and lexical_diversity < 0.5:
            reason = f"Low lexical diversity ({lexical_diversity:.2f} < 0.50)."
            cls._log_quality(entity_name, value, 0.2, reason, "FAIL")
            return EntityQualityResult(valid=False, score=0.2, reason=reason)

        # ── 4. Stop-Word Domination & Stop-Word Phrase Check ──────────────────
        stop_count = sum(1 for tok in tokens if tok in _STOP_WORDS)
        stop_ratio = stop_count / total_tokens if total_tokens > 0 else 0.0

        # Disallow phrases containing awkward stop-word combinations (e.g. "inside the", "with the")
        bad_phrases = ("inside the", "with the", "from the", "in the", "on the", "of the", "about the", "at the", "by the")
        if any(bp in cleaned for bp in bad_phrases):
            reason = f"Entity contains stop-word phrase artifact."
            cls._log_quality(entity_name, value, 0.1, reason, "FAIL")
            return EntityQualityResult(valid=False, score=0.1, reason=reason)

        if total_tokens >= 3 and stop_ratio >= 0.40:
            reason = f"Stop-word domination ({stop_ratio:.0%} stop words)."
            cls._log_quality(entity_name, value, 0.1, reason, "FAIL")
            return EntityQualityResult(valid=False, score=0.1, reason=reason)

        # ── 5. Punctuation / Non-alphanumeric Check ────────────────────────
        alpha_count = sum(1 for c in cleaned if c.isalnum())
        if alpha_count == 0:
            reason = "Entity contains zero alphanumeric characters."
            cls._log_quality(entity_name, value, 0.0, reason, "FAIL")
            return EntityQualityResult(valid=False, score=0.0, reason=reason)

        # ── PASS ────────────────────────────────────────────────────────────
        cls._log_quality(entity_name, value, 1.0, "Entity quality validation passed.", "PASS")
        return EntityQualityResult(valid=True, score=1.0, reason=None)

    @classmethod
    def validate_entities_dict(
        cls, entities: dict[str, Any], original_text: str | None = None
    ) -> tuple[dict[str, Any], list[str]]:
        """
        Validate all entities in a dictionary.
        Returns (clean_valid_entities, failed_entity_keys).
        """
        valid_entities: dict[str, Any] = {}
        failed_keys: list[str] = []

        for key, val in entities.items():
            if isinstance(val, str):
                result = cls.validate(key, val)
                if result.valid:
                    valid_entities[key] = val
                else:
                    failed_keys.append(key)
            else:
                valid_entities[key] = val

        # Deduplicate: if project_name and title are identical (e.g. "jinga inside the jinga file")
        # and no explicit project preposition exists in transcript, project_name is missing
        if "project_name" in valid_entities and "title" in valid_entities:
            p_val = str(valid_entities["project_name"]).strip().lower()
            t_val = str(valid_entities["title"]).strip().lower()
            if p_val == t_val:
                text_lower = (original_text or "").lower()
                if "in project" not in text_lower and "for project" not in text_lower and "project named" not in text_lower:
                    del valid_entities["project_name"]
                    failed_keys.append("project_name")

        return valid_entities, failed_keys

    @staticmethod
    def _log_quality(
        entity_name: str, value: str, score: float, reason: str, decision: str
    ) -> None:
        logger.info(
            "\n--- ENTITY QUALITY VALIDATION ---\n"
            "Entity Key          : %s\n"
            "Extracted Entity    : %r\n"
            "Entity Quality Score: %.2f\n"
            "Entity Quality Reason: %s\n"
            "Decision            : %s\n"
            "---------------------------------",
            entity_name, value, score, reason, decision
        )
