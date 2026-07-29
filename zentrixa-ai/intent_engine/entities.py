"""
intent_engine.entities
======================
Context-Aware Sequential Slot Filling Entity Extraction Engine.

Principles
----------
1. Intent-Aware Slot Sequence:
   Slots are extracted sequentially in priority order (e.g. title -> project_name -> assignee -> status -> priority -> due_date).
2. Span Consumption & Non-Reusability:
   When a slot is extracted, its character span [start, end] is consumed and masked out of the transcript.
   Subsequent slots CANNOT reuse previously consumed text.
3. Individual Slot Rules & Confidence:
   Each slot has dedicated, strict regex patterns and quality validation.
   Values below threshold (0.70) or invalid quality are rejected (returned as None).
4. Detailed Slot Debug Logging:
   Every slot evaluation logs candidate, confidence, decision, consumed span, and remaining text.
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass
from typing import Any

from intent_engine.entity_quality import EntityQualityValidator
from intent_engine.normalizer import normalize, strip_leading_articles

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Status normalisation map
# ---------------------------------------------------------------------------

STATUS_MAP: dict[str, str] = {
    "todo": "pending",
    "to do": "pending",
    "to-do": "pending",
    "pending": "pending",
    "not started": "pending",
    "in progress": "in-progress",
    "in-progress": "in-progress",
    "progress": "in-progress",
    "doing": "in-progress",
    "wip": "in-progress",
    "working on": "in-progress",
    "review": "review",
    "in review": "review",
    "code review": "review",
    "done": "completed",
    "completed": "completed",
    "complete": "completed",
    "finished": "completed",
    "closed": "completed",
    "resolved": "completed",
    "blocked": "blocked",
    "on hold": "blocked",
}

_STATUS_SORTED = sorted(STATUS_MAP.items(), key=lambda kv: len(kv[0]), reverse=True)

_NAME_STOP = frozenset({
    "in", "for", "to", "from", "with", "and", "by", "on", "at", "of",
    "assigned", "assign", "due", "priority", "status", "project", "task",
})


@dataclass
class SlotResult:
    value: str | None = None
    confidence: float = 0.0
    start: int = -1
    end: int = -1
    source_span: str = ""


def _take_until(value: str, stop_words: frozenset[str] = _NAME_STOP) -> str:
    pattern = r"\b(?:" + "|".join(re.escape(w) for w in stop_words) + r")\b"
    parts = re.split(pattern, value, maxsplit=1, flags=re.I)
    return normalize(parts[0])


class EntityExtractor:
    """
    Context-aware sequential slot filling entity extractor with span masking.
    """

    @classmethod
    def extract(
        cls,
        text: str,
        intent: str,
        *,
        needs_task: bool = False,
        needs_project: bool = False,
        needs_user: bool = False,
        needs_status: bool = False,
        needs_priority: bool = False,
        needs_date: bool = False,
    ) -> dict[str, Any]:
        """
        Sequentially extract slots, consuming matched spans so text is never reused.
        """
        working_text = text
        result: dict[str, Any] = {}

        # 1. Task Name / Title Slot
        if needs_task:
            slot = cls._extract_slot_task(working_text)
            if slot.value and slot.confidence >= 0.70:
                result["title"] = slot.value
                working_text = cls._consume_span(working_text, slot.start, slot.end)
                cls._log_slot_extraction("title", slot.value, slot.confidence, "ACCEPTED", slot.start, slot.end, slot.source_span, working_text)
            else:
                cls._log_slot_extraction("title", slot.value, slot.confidence, "REJECTED", slot.start, slot.end, slot.source_span, working_text)

        # 2. Project Name Slot
        if needs_project:
            slot = cls._extract_slot_project(working_text)
            if slot.value and slot.confidence >= 0.70:
                result["project_name"] = slot.value
                working_text = cls._consume_span(working_text, slot.start, slot.end)
                cls._log_slot_extraction("project_name", slot.value, slot.confidence, "ACCEPTED", slot.start, slot.end, slot.source_span, working_text)
            else:
                cls._log_slot_extraction("project_name", slot.value, slot.confidence, "REJECTED", slot.start, slot.end, slot.source_span, working_text)

        # 3. Assignee Slot
        if needs_user:
            slot = cls._extract_slot_user(working_text)
            if slot.value and slot.confidence >= 0.70:
                result["assignee"] = slot.value
                working_text = cls._consume_span(working_text, slot.start, slot.end)
                cls._log_slot_extraction("assignee", slot.value, slot.confidence, "ACCEPTED", slot.start, slot.end, slot.source_span, working_text)
            else:
                cls._log_slot_extraction("assignee", slot.value, slot.confidence, "REJECTED", slot.start, slot.end, slot.source_span, working_text)

        # 4. Status Slot
        if needs_status:
            slot = cls._extract_slot_status(working_text)
            if slot.value and slot.confidence >= 0.70:
                result["status"] = slot.value
                working_text = cls._consume_span(working_text, slot.start, slot.end)
                cls._log_slot_extraction("status", slot.value, slot.confidence, "ACCEPTED", slot.start, slot.end, slot.source_span, working_text)

        # 5. Priority Slot
        if needs_priority:
            slot = cls._extract_slot_priority(working_text)
            if slot.value and slot.confidence >= 0.70:
                result["priority"] = slot.value
                working_text = cls._consume_span(working_text, slot.start, slot.end)
                cls._log_slot_extraction("priority", slot.value, slot.confidence, "ACCEPTED", slot.start, slot.end, slot.source_span, working_text)

        # 6. Due Date Slot
        if needs_date:
            slot = cls._extract_slot_date(working_text)
            if slot.value and slot.confidence >= 0.70:
                result["due_date"] = slot.value
                working_text = cls._consume_span(working_text, slot.start, slot.end)
                cls._log_slot_extraction("due_date", slot.value, slot.confidence, "ACCEPTED", slot.start, slot.end, slot.source_span, working_text)

        return result

    @staticmethod
    def _consume_span(text: str, start: int, end: int) -> str:
        """Mask out consumed character indices with spaces."""
        if start < 0 or end <= start or start >= len(text):
            return text
        actual_end = min(end, len(text))
        return text[:start] + (" " * (actual_end - start)) + text[actual_end:]

    # ------------------------------------------------------------------
    # Slot-Specific Extractors
    # ------------------------------------------------------------------

    @classmethod
    def _clean_cand(cls, cand_raw: str) -> str:
        cleaned = cand_raw.strip()
        pattern = r"^(?:by\s+name\s+of|by\s+the\s+name\s+of|with\s+the\s+name\s+of|under\s+the\s+name\s+of|with\s+name\s+of|name\s+of|which\s+is|name\s+is|named?\s+as|called\s+as|with\s+name|name\s+with|by\s+name|named?|called|titled?|title|is|as|name)\s+"
        prev = ""
        while cleaned != prev:
            prev = cleaned
            cleaned = re.sub(pattern, "", cleaned, flags=re.I).strip()
            cleaned = strip_leading_articles(cleaned)
        return _take_until(cleaned)

    @classmethod
    def _extract_slot_task(cls, text: str) -> SlotResult:
        patterns = [
            r"\b(?:by\s+name\s+of|by\s+the\s+name\s+of|with\s+name\s+of|name\s+with|with\s+name|which\s+is|name\s+is|named?\s+as|called\s+as|named?|called|titled?|title|is|as|name)\s+([A-Za-z0-9 _-]{1,50})",
            r"\b(?:create|make|add|start|new)\s+(?:a\s+|the\s+)?task\s+(?:by\s+name\s+of|by\s+the\s+name\s+of|with\s+name\s+of|with\s+name|name\s+with|which\s+is|name\s+is|named?\s+as|called\s+as|with|named?|called|titled?|title|is|as|name)?\s*([A-Za-z0-9 _-]{1,50})",
            r"\btask\s+([A-Za-z0-9 _-]{1,50})",
        ]
        for p in patterns:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                cand_raw = m.group(1).strip()
                cand_clean = cls._clean_cand(cand_raw)
                if cand_clean and len(cand_clean) > 1 and cand_clean.lower() not in {"task", "ticket", "issue", "it", "name"}:
                    q = EntityQualityValidator.validate("title", cand_clean)
                    if q.valid:
                        return SlotResult(
                            value=cand_clean,
                            confidence=0.95,
                            start=m.start(),
                            end=m.end(),
                            source_span=m.group(0),
                        )
        return SlotResult()

    @classmethod
    def _extract_slot_project(cls, text: str) -> SlotResult:
        patterns = [
            r"\b(?:in|inside|under|from|for)\s+(?:the\s+)?(?:project|workspace|repo)\s+([A-Za-z0-9 _-]{1,50})",
            r"\b(?:create|make|add|start|build|new|launch|set\s+up|setup)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:project|workspace|repo)\s+(?:by\s+name\s+of|by\s+the\s+name\s+of|with\s+name\s+of|with\s+name|name\s+with|which\s+is|name\s+is|named?\s+as|called\s+as|with|named?|called|titled?|title|is|as|name)?\s*([A-Za-z0-9 _-]{1,50})",
            r"\b(?:project|workspace|repo)\s+(?:by\s+name\s+of|by\s+the\s+name\s+of|with\s+name\s+of|with\s+name|name\s+with|which\s+is|name\s+is|named?\s+as|called\s+as|with|named?|called|titled?|title|is|as|name)?\s*([A-Za-z0-9 _-]{1,50})",
        ]
        for p in patterns:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                cand_raw = m.group(1).strip()
                cand_clean = cls._clean_cand(cand_raw)
                if cand_clean and len(cand_clean) > 1 and cand_clean.lower() not in {"project", "workspace", "repo", "it", "file", "name"}:
                    q = EntityQualityValidator.validate("project_name", cand_clean)
                    if q.valid:
                        return SlotResult(
                            value=cand_clean,
                            confidence=0.95,
                            start=m.start(),
                            end=m.end(),
                            source_span=m.group(0),
                        )
        return SlotResult()

    @classmethod
    def _extract_slot_user(cls, text: str) -> SlotResult:
        patterns = [
            r"\b(?:assign|assigned|delegate|delegated|give|given)\s+(?:task\s+)?to\s+([A-Za-z0-9 _-]{1,30})",
            r"\bassigned\s+user\s+([A-Za-z0-9 _-]{1,30})",
            r"\buser\s+([A-Za-z0-9 _-]{1,30})",
        ]
        _EXCLUDE = {"task", "project", "done", "review", "pending", "me", "us", "it", "someone", "anyone", "name"}
        for p in patterns:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                cand_raw = m.group(1).strip()
                cand_clean = strip_leading_articles(_take_until(cand_raw))
                if cand_clean and len(cand_clean) > 1 and cand_clean.lower() not in _EXCLUDE:
                    q = EntityQualityValidator.validate("assignee", cand_clean)
                    if q.valid:
                        return SlotResult(
                            value=cand_clean,
                            confidence=0.90,
                            start=m.start(),
                            end=m.end(),
                            source_span=m.group(0),
                        )
        return SlotResult()

    @classmethod
    def _extract_slot_status(cls, text: str) -> SlotResult:
        lower = text.lower()
        for phrase, mapped in _STATUS_SORTED:
            m = re.search(rf"\b{re.escape(phrase)}\b", lower)
            if m:
                return SlotResult(
                    value=mapped,
                    confidence=0.90,
                    start=m.start(),
                    end=m.end(),
                    source_span=m.group(0),
                )
        return SlotResult()

    @classmethod
    def _extract_slot_priority(cls, text: str) -> SlotResult:
        if m := re.search(r"\b(high(?:\s+priority)?|urgent|critical|blocker)\b", text, re.I):
            return SlotResult(value="high", confidence=0.95, start=m.start(), end=m.end(), source_span=m.group(0))
        if m := re.search(r"\b(medium(?:\s+priority)?|normal|moderate)\b", text, re.I):
            return SlotResult(value="medium", confidence=0.95, start=m.start(), end=m.end(), source_span=m.group(0))
        if m := re.search(r"\b(low(?:\s+priority)?|minor|trivial)\b", text, re.I):
            return SlotResult(value="low", confidence=0.95, start=m.start(), end=m.end(), source_span=m.group(0))
        return SlotResult()

    @classmethod
    def _extract_slot_date(cls, text: str) -> SlotResult:
        patterns = [
            r"\b(tomorrow|today|yesterday|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month))\b",
            r"\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:\s*,?\s*\d{4})?)\b",
            r"\bin\s+(\d+\s+(?:days?|weeks?|months?))\b",
        ]
        for p in patterns:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                return SlotResult(
                    value=m.group(1).strip(),
                    confidence=0.85,
                    start=m.start(),
                    end=m.end(),
                    source_span=m.group(0),
                )
        return SlotResult()

    @staticmethod
    def _log_slot_extraction(
        slot_name: str,
        value: str | None,
        confidence: float,
        decision: str,
        start: int,
        end: int,
        source_span: str,
        remaining_text: str,
    ) -> None:
        logger.info(
            "\n--- SLOT EXTRACTION TRACE ---\n"
            "Slot Name     : %s\n"
            "Candidate     : %r\n"
            "Confidence    : %.2f\n"
            "Decision      : %s\n"
            "Consumed Span : [%d, %d] (%r)\n"
            "Remaining Text: %r\n"
            "-----------------------------",
            slot_name, value, confidence, decision, start, end, source_span, remaining_text
        )
