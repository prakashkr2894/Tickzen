"""
intent_engine.plugins.base
===========================
Abstract base class (interface) every intent plugin must implement.

To create a new plugin (e.g. KubernetesPlugin):
  1. Create `intent_engine/plugins/kubernetes.py`
  2. Subclass IntentPlugin
  3. Implement namespace, intent_definitions, extract_entities
  4. Register in api.py: app.state.engine.register(KubernetesPlugin())

No changes to engine.py or any existing plugin are required.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, TypedDict


# ---------------------------------------------------------------------------
# Intent definition schema
# ---------------------------------------------------------------------------

class IntentDefinition(TypedDict):
    name:              str           # e.g. "CREATE_TASK" — must be UPPER_SNAKE_CASE
    verbs:             list[str]     # primary trigger words (exact match)
    synonyms:          list[str]     # accepted synonyms (fuzzy + exact)
    entity_nouns:      list[str]     # nouns that confirm this intent (task, project, …)
    needs_task:        bool          # hint for entity extractor
    needs_project:     bool
    needs_user:        bool
    needs_status:      bool
    needs_priority:    bool
    needs_date:        bool
    # optional — if set, these entities MUST be extracted for local execution
    required_entities: list[str]


# ---------------------------------------------------------------------------
# Abstract plugin
# ---------------------------------------------------------------------------

class IntentPlugin(ABC):
    """
    Every integration implements this interface.

    Plugins are completely self-contained. The engine never looks inside
    the plugin beyond what this interface exposes.
    """

    @property
    @abstractmethod
    def namespace(self) -> str:
        """
        Unique plugin identifier, e.g. 'task_manager', 'kubernetes'.
        Used in logs and ClassificationResult.plugin field.
        """

    @property
    @abstractmethod
    def intent_definitions(self) -> list[IntentDefinition]:
        """
        Declare every intent this plugin can handle.
        Called once at registration time; results are cached by the engine.
        """

    @abstractmethod
    def extract_entities(self, text: str, intent_name: str) -> dict[str, Any]:
        """
        Extract domain-specific structured entities for a given intent.

        Parameters
        ----------
        text        : original (non-filtered) transcript text
        intent_name : matched intent name (e.g. "CREATE_TASK")

        Returns
        -------
        dict with extracted fields; empty dict if nothing found.
        Example: {"title": "Fix Login", "priority": "high", "assignee": "Rahul"}
        """
