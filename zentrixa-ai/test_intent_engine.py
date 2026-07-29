from intent_engine.normalizer import normalize, normalize_for_matching
from intent_engine.confidence import ConfidenceScorer
from intent_engine.entities import EntityExtractor
from intent_engine.plugins.task_manager import TaskManagerPlugin
from intent_engine.engine import IntentEngine

engine = IntentEngine(threshold=0.90)
engine.register(TaskManagerPlugin())

tests = [
    "create task Fix Login Bug assigned to Rahul tomorrow",
    "delete the task Homepage Redesign",
    "assign the task payment integration to Sarah",
    "show me overdue tasks",
    "what is the meaning of life",
    "create project Alpha Backend",
    "mark Fix Login Bug as done",
    "start timer for task payment integration",
    "show dashboard",
]

print("=" * 70)
for text in tests:
    result = engine.classify(text)
    route = result["route"].upper()
    intent = result["intent"] or "NONE"
    conf = result["confidence"]
    print(f"[{route:5s}] {intent:30s} {conf:.2f}  \"{text[:45]}\"")

print("=" * 70)
print(f"Plugins: {engine.plugin_names}")
print("All imports OK. Engine functional.")
