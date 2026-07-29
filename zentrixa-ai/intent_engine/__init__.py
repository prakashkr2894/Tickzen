"""
intent_engine
=============
Plugin-based Hybrid Intent Engine.

Quick start
-----------
from intent_engine import IntentEngine, ClassificationResult
from intent_engine.plugins.task_manager import TaskManagerPlugin

engine = IntentEngine(threshold=0.90)
engine.register(TaskManagerPlugin())

result: ClassificationResult = engine.classify("create task Fix Login Bug")
"""

from intent_engine.engine import (  # noqa: F401
    ClassificationResult,
    IntentDefinition,
    IntentEngine,
    IntentPlugin,
)
