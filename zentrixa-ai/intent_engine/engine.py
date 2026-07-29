"""
intent_engine.engine
=====================
Core classification engine — plugin registry + classification pipeline.

Pipeline (per request)
-----------------------
1. preprocess()     Validate + clean transcript (rejects garbage → route="repeat")
2. rule_matching    Score every registered intent via ConfidenceScorer
3. decision         3-way route based on two configurable thresholds:

    confidence >= DIRECT_THRESHOLD  →  route = "local"   (execute backend directly)
    confidence >= LLM_THRESHOLD     →  route = "llm"     (forward to LLM)
    confidence <  LLM_THRESHOLD     →  route = "repeat"  (ask user to repeat)

Configuration (env vars)
------------------------
INTENT_DIRECT_THRESHOLD   default 0.90
INTENT_LLM_THRESHOLD      default 0.60
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Literal, TypedDict

from intent_engine.confidence import ConfidenceScorer
from intent_engine.entity_quality import EntityQualityValidator
from intent_engine.global_intents import GlobalIntentDetector
from intent_engine.normalizer import normalize_for_matching
from intent_engine.preprocessor import preprocess
from intent_engine.plugins.base import IntentDefinition, IntentPlugin

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Re-export for convenience
# ---------------------------------------------------------------------------

__all__ = [
    "ClassificationResult",
    "IntentDefinition",
    "IntentEngine",
    "IntentPlugin",
]


# ---------------------------------------------------------------------------
# Public result type
# ---------------------------------------------------------------------------

RouteType = Literal["local", "llm", "repeat"]


class ClassificationResult(TypedDict):
    intent:     str | None
    plugin:     str | None
    confidence: float
    entities:   dict[str, Any]
    route:      RouteType
    transcript: str
    elapsed_ms: int
    reply:      str | None


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class IntentEngine:
    """
    Plugin registry and classification orchestrator.

    Thread-safe (read-only after setup — register() is called at startup only).

    Usage
    -----
    engine = IntentEngine()
    engine.register(TaskManagerPlugin())
    result = engine.classify("create task Fix Login Bug")
    """

    def __init__(
        self,
        direct_threshold: float | None = None,
        llm_threshold:    float | None = None,
    ) -> None:
        self._direct_threshold = direct_threshold or float(
            os.getenv("INTENT_DIRECT_THRESHOLD", "0.90")
        )
        self._llm_threshold = llm_threshold or float(
            os.getenv("INTENT_LLM_THRESHOLD", "0.60")
        )
        self._plugins: list[IntentPlugin] = []
        # Flattened list of (plugin, defn) pairs — built on first classify()
        self._index: list[tuple[IntentPlugin, IntentDefinition]] | None = None

        logger.info(
            "IntentEngine thresholds: direct=%.2f  llm=%.2f",
            self._direct_threshold,
            self._llm_threshold,
        )

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, plugin: IntentPlugin) -> None:
        """
        Register a plugin with this engine.
        Call at application startup (lifespan) — not during requests.
        """
        self._plugins.append(plugin)
        self._index = None  # invalidate cached index
        logger.info(
            "Registered plugin '%s' with %d intents.",
            plugin.namespace,
            len(plugin.intent_definitions),
        )

    @property
    def plugin_names(self) -> list[str]:
        return [p.namespace for p in self._plugins]

    # ------------------------------------------------------------------
    # Classification  (the single public entry point)
    # ------------------------------------------------------------------

    def classify(self, text: str) -> ClassificationResult:
        """
        Full pipeline: preprocess → global intent → rule-match → score → 3-way decision.

        Parameters
        ----------
        text : raw transcript string from Whisper / AssemblyAI

        Returns
        -------
        ClassificationResult with route in {"local", "llm", "repeat"}
        """
        t0 = time.monotonic()

        # ── Step 1: Preprocess ───────────────────────────────────────────────
        prep = preprocess(text)

        logger.info(
            "[STAGE 1: PREPROCESS] raw=%r -> valid=%s cleaned=%r (reason=%s)",
            text, prep.valid, prep.cleaned_text, prep.reason
        )

        if not prep.valid:
            elapsed = int((time.monotonic() - t0) * 1000)
            self._log_structured_trace(
                raw=text, cleaned=prep.cleaned_text,
                global_intent=None, command_intent=None,
                entities={}, confidence=0.0, route="repeat",
                reason=prep.reason or "Meaningless or garbage transcript."
            )
            return self._repeat_result(prep.cleaned_text, 0.0, elapsed)

        cleaned  = prep.cleaned_text
        matched  = normalize_for_matching(cleaned)
        index    = self._get_index()

        # ── Step 2: Global Conversation Intent Detection ────────────────────
        global_res = GlobalIntentDetector.detect(cleaned)
        if global_res.matched:
            elapsed = int((time.monotonic() - t0) * 1000)
            self._log_structured_trace(
                raw=text, cleaned=cleaned,
                global_intent=global_res.intent, command_intent=None,
                entities={}, confidence=1.0, route="local",
                reason=f"Matched global conversation intent: {global_res.intent}"
            )
            return ClassificationResult(
                intent     = global_res.intent,
                plugin     = "global",
                confidence = 1.0,
                entities   = {},
                route      = "local",
                transcript = cleaned,
                elapsed_ms = elapsed,
                reply      = global_res.reply,
            )

        logger.info("[STAGE 2: NORMALIZATION] normalized_for_matching=%r", matched)

        # ── Step 3: Rule matching + scoring ─────────────────────────────────
        best_score:    float           = 0.0
        best_plugin:   IntentPlugin | None = None
        best_defn:     IntentDefinition | None = None
        best_entities: dict[str, Any]  = {}
        best_breakdown = None

        for plugin, defn in index:
            raw_entities  = plugin.extract_entities(cleaned, defn["name"])
            valid_entities, failed_keys = EntityQualityValidator.validate_entities_dict(raw_entities, cleaned)
            
            breakdown = ConfidenceScorer.score(
                normalised_text = matched,
                original_text   = cleaned,
                verbs           = tuple(defn["verbs"]),
                synonyms        = tuple(defn.get("synonyms", [])),
                entity_nouns    = tuple(defn["entity_nouns"]),
                extracted       = valid_entities,
            )
            if breakdown.score > 0.5:
                logger.info(
                    "[STAGE 3: SCORING & QUALITY] intent=%s | score=%.4f | valid_entities=%s | failed_keys=%s",
                    defn["name"], breakdown.score, valid_entities, failed_keys,
                )
            if breakdown.score > best_score:
                best_score     = breakdown.score
                best_plugin    = plugin
                best_defn      = defn
                best_entities  = valid_entities

        elapsed = int((time.monotonic() - t0) * 1000)

        # ── Step 4: Decision ──────────────────────────────────────────────────
        if best_defn is not None and best_score >= self._direct_threshold:
            req_entities = best_defn.get("required_entities", [])
            missing_reqs = [r for r in req_entities if not best_entities.get(r)]
            if missing_reqs:
                self._log_structured_trace(
                    raw=text, cleaned=cleaned,
                    global_intent=None, command_intent=best_defn["name"],
                    entities=best_entities, confidence=best_score, route="llm",
                    reason=f"Matched command verb+noun strongly but missing required entities: {missing_reqs}"
                )
                return ClassificationResult(
                    intent     = best_defn["name"],
                    plugin     = best_plugin.namespace if best_plugin else None,  # type: ignore[union-attr]
                    confidence = best_score,
                    entities   = best_entities,
                    route      = "llm",
                    transcript = cleaned,
                    elapsed_ms = elapsed,
                    reply      = None,
                )

            self._log_structured_trace(
                raw=text, cleaned=cleaned,
                global_intent=None, command_intent=best_defn["name"],
                entities=best_entities, confidence=best_score, route="local",
                reason="Matched command intent with high confidence and valid required entities."
            )
            return ClassificationResult(
                intent     = best_defn["name"],
                plugin     = best_plugin.namespace if best_plugin else None,  # type: ignore[union-attr]
                confidence = best_score,
                entities   = best_entities,
                route      = "local",
                transcript = cleaned,
                elapsed_ms = elapsed,
                reply      = None,
            )

        if best_defn is not None and best_score >= self._llm_threshold:
            self._log_structured_trace(
                raw=text, cleaned=cleaned,
                global_intent=None, command_intent=best_defn["name"],
                entities=best_entities, confidence=best_score, route="llm",
                reason="Moderate command confidence -> forward to LLM."
            )
            return ClassificationResult(
                intent     = best_defn["name"],
                plugin     = best_plugin.namespace if best_plugin else None,  # type: ignore[union-attr]
                confidence = best_score,
                entities   = best_entities,
                route      = "llm",
                transcript = cleaned,
                elapsed_ms = elapsed,
                reply      = None,
            )

        # Fallback: check if meaningful action verbs exist in transcript
        action_verbs = {"create", "make", "start", "delete", "remove", "rename", "assign", "update", "show", "get", "list", "find"}
        has_action_verb = any(v in cleaned.split() for v in action_verbs)
        if has_action_verb:
            cmd_name = best_defn["name"] if best_defn else "UNKNOWN_ACTION"
            self._log_structured_trace(
                raw=text, cleaned=cleaned,
                global_intent=None, command_intent=cmd_name,
                entities=best_entities, confidence=0.65, route="llm",
                reason="Imperfect speech containing action verb -> forward to LLM fallback."
            )
            return ClassificationResult(
                intent     = cmd_name,
                plugin     = best_plugin.namespace if best_plugin else "task_manager",
                confidence = 0.65,
                entities   = best_entities,
                route      = "llm",
                transcript = cleaned,
                elapsed_ms = elapsed,
                reply      = None,
            )

        # Rejection: Neither global intent nor command intent could be identified
        self._log_structured_trace(
            raw=text, cleaned=cleaned,
            global_intent=None, command_intent=None,
            entities={}, confidence=best_score, route="repeat",
            reason="Low confidence, no global intent or command action detected."
        )
        return self._repeat_result(cleaned, best_score, elapsed)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _get_index(self) -> list[tuple[IntentPlugin, IntentDefinition]]:
        """Build (and cache) the flat intent index from all registered plugins."""
        if self._index is None:
            self._index = [
                (plugin, defn)
                for plugin in self._plugins
                for defn  in plugin.intent_definitions
            ]
        return self._index

    @staticmethod
    def _log_structured_trace(
        raw: str,
        cleaned: str,
        global_intent: str | None,
        command_intent: str | None,
        entities: dict[str, Any],
        confidence: float,
        route: str,
        reason: str | None = None,
    ) -> None:
        logger.info(
            "\n=== HYBRID INTENT ENGINE TRACE ===\n"
            "Raw Transcript       : %s\n"
            "Normalized Transcript: %s\n"
            "Global Intent        : %s\n"
            "Command Intent       : %s\n"
            "Extracted Entities   : %s\n"
            "Confidence Score     : %.2f\n"
            "Routing Decision     : %s\n"
            "Reason for Decision  : %s\n"
            "==================================",
            raw, cleaned,
            global_intent or "None",
            command_intent or "None",
            entities,
            confidence,
            route.upper(),
            reason or "Matched intent pattern cleanly"
        )

    @staticmethod
    def _repeat_result(
        transcript: str, confidence: float, elapsed_ms: int
    ) -> ClassificationResult:
        return ClassificationResult(
            intent     = None,
            plugin     = None,
            confidence = confidence,
            entities   = {},
            route      = "repeat",
            transcript = transcript,
            elapsed_ms = elapsed_ms,
            reply      = "I didn't quite catch that. How can I help you with your projects or tasks?",
        )
