import re
from typing import Dict, Optional


STATUS_ALIASES = {
    "todo": "pending",
    "to do": "pending",
    "pending": "pending",
    "in progress": "in-progress",
    "progress": "in-progress",
    "doing": "in-progress",
    "review": "review",
    "done": "completed",
    "completed": "completed",
    "complete": "completed",
}


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip(" \t\n\r\"'.,!?")


def _strip_leading_tokens(value: str) -> str:
    value = _clean(value)
    value = re.sub(r"^(the|a|an|my|this|that)\s+", "", value, flags=re.I)
    return _clean(value)


def _take_until(value: str, stop_words: list[str]) -> str:
    pattern = r"\b(?:%s)\b" % "|".join(re.escape(word) for word in stop_words)
    parts = re.split(pattern, value, maxsplit=1, flags=re.I)
    return _clean(parts[0])


def _extract_between(text: str, start: str, stop_words: list[str]) -> str:
    match = re.search(start, text, flags=re.I)
    if not match:
        return ""
    return _take_until(match.group(1), stop_words)


def _find_status(text: str) -> Optional[str]:
    normalized = _clean(text).lower()

    for phrase, mapped in sorted(STATUS_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        if re.search(rf"\b{re.escape(phrase)}\b", normalized, flags=re.I):
            return mapped

    return None


def extract_entities(text: str, intent: str | None = None) -> Dict[str, str]:
    normalized = _clean(text)
    lower = normalized.lower()
    entities: Dict[str, str] = {}

    task_patterns = [
        r"(?:delete|remove|cancel|trash|erase|assign|move|update|create)\s+(?:the\s+)?task\s+(.+?)(?:\s+from\b|\s+to\b|\s+in\b|\s+of\b|\s+on\b|$)",
        r"(?:delete|remove|cancel|trash|erase)\s+(.+?)(?:\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)",
        r"(?:assign|move|update|create)\s+(.+?)(?:\s+to\b|\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)",
    ]

    project_patterns = [
        r"\bfrom\s+project\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
        r"\bfrom\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
        r"\bproject\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
    ]

    user_patterns = [
        r"\bto\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$",
        r"\bassign(?:ed)?\s+(?:to\s+)?([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$",
        r"\bfor\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$",
    ]

    status_patterns = [
        r"\bmove\s+task\s+.+?\s+to\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$",
        r"\bto\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$",
        r"\bstatus\s+is\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$",
    ]

    if intent in {"delete_task", "assign_task", "move_task", "update_deadline", "create_task"}:
        for pattern in task_patterns:
            match = re.search(pattern, normalized, flags=re.I)
            if match and match.group(1):
                task_name = _strip_leading_tokens(_take_until(match.group(1), ["from", "to", "in", "of", "on"]))
                if task_name:
                    entities["task_name"] = task_name
                    break

    if intent in {"delete_task", "assign_task", "create_task", "analyze_project", "add_member"}:
        for pattern in project_patterns:
            match = re.search(pattern, normalized, flags=re.I)
            if match and match.group(1):
                project_name = _strip_leading_tokens(_take_until(match.group(1), ["to", "by", "for", "task"]))
                if project_name:
                    entities["project_name"] = project_name
                    break

    if intent in {"assign_task", "add_member"}:
        for pattern in user_patterns:
            match = re.search(pattern, normalized, flags=re.I)
            if match and match.group(1):
                user_name = _strip_leading_tokens(match.group(1))
                if user_name and user_name.lower() not in {"task", "project", "done", "review"}:
                    entities["user_name"] = user_name
                    break

    if intent in {"move_task", "update_deadline"}:
        for pattern in status_patterns:
            match = re.search(pattern, normalized, flags=re.I)
            if match and match.group(1):
                status = _find_status(match.group(1)) or _clean(match.group(1)).lower()
                if status:
                    entities["status"] = status
                    break

    if intent == "create_task" and "task_name" not in entities:
        match = re.search(r"(?:create|add|make)\s+(?:a\s+)?task\s+(.+?)(?:\s+for\b|\s+in\b|\s+to\b|$)", normalized, flags=re.I)
        if match and match.group(1):
            task_name = _strip_leading_tokens(_take_until(match.group(1), ["for", "in", "to"]))
            if task_name:
                entities["task_name"] = task_name

    if intent == "move_task" and "status" not in entities:
        status = _find_status(normalized)
        if status:
            entities["status"] = status

    return entities
