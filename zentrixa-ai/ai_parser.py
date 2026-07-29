import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

BASE_DIR = Path(__file__).resolve().parent

SUPPORTED_ACTIONS = [
    "create_task",
    "create_panel",
    "delete_task",
    "assign_task",
    "move_task",
    "create_project",
    "delete_project",
    "add_member",
    "update_deadline",
    "analyze_project",
]

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
    "blocked": "blocked",
}


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip(" \t\n\r\"'.,!?")


def _strip_prefixes(value: str) -> str:
    value = _clean(value)
    return re.sub(r"^(the|a|an|my|this|that)\s+", "", value, flags=re.I).strip()


def _find_status(text: str) -> Optional[str]:
    normalized = _clean(text).lower()
    for phrase, mapped in sorted(STATUS_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        if re.search(rf"\b{re.escape(phrase)}\b", normalized, flags=re.I):
            return mapped
    return None


def _fallback_parse(text: str) -> Dict[str, Any]:
    normalized = _clean(text)
    lower = normalized.lower()
    action = "unknown"
    task_name = None
    project_name = None
    panel_name = None
    user_name = None
    status = None

    if re.search(r"\b(delete|remove|cancel|trash|erase)\b", lower):
        action = "delete_task" if re.search(r"\btask\b", lower) else "delete_project"
    elif re.search(r"\b(assign|give|delegate)\b", lower):
        action = "assign_task"
    elif re.search(r"\b(move|shift|change)\b", lower):
        action = "move_task"
    elif re.search(r"\b(create|add|make|new)\b", lower) and re.search(r"\bpanel\b", lower):
        action = "create_panel"
    elif re.search(r"\b(create|add|make|new)\b", lower) and re.search(r"\bproject\b", lower):
        action = "create_project"
    elif re.search(r"\b(create|add|make|new)\b", lower) and re.search(r"\btask\b", lower):
        action = "create_task"
    elif re.search(r"\b(add member|invite|add user|add teammate)\b", lower):
        action = "add_member"
    elif re.search(r"\b(deadline|due date|reschedule)\b", lower):
        action = "update_deadline"
    elif re.search(r"\b(analyze|analyse|summary|summarize|health|status)\b", lower):
        action = "analyze_project"

    task_patterns = [
        r"(?:delete|remove|cancel|trash|erase|assign|move|update|create)\s+(?:the\s+)?task\s+(.+?)(?:\s+from\b|\s+to\b|\s+in\b|\s+of\b|\s+on\b|$)",
        r"(?:delete|remove|cancel|trash|erase)\s+(.+?)(?:\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)",
        r"(?:assign|move|update|create)\s+(.+?)(?:\s+to\b|\s+from\b|\s+in\b|\s+of\b|\s+on\b|$)",
    ]
    for pattern in task_patterns:
        match = re.search(pattern, normalized, flags=re.I)
        if match and match.group(1):
            candidate = _strip_prefixes(match.group(1))
            candidate = re.split(r"\b(?:from|to|in|of|on)\b", candidate, maxsplit=1, flags=re.I)[0]
            candidate = _strip_prefixes(candidate)
            if candidate:
                task_name = candidate
                break

    project_patterns = [
        r"\bfrom\s+project\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
        r"\bin\s+project\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
        r"\bproject\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
        r"\bfrom\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
        r"\bin\s+(.+?)(?:\s+to\b|\s+by\b|\s+for\b|$)",
    ]
    for pattern in project_patterns:
        match = re.search(pattern, normalized, flags=re.I)
        if match and match.group(1):
            candidate = _strip_prefixes(match.group(1))
            candidate = re.split(r"\b(?:to|by|for|task)\b", candidate, maxsplit=1, flags=re.I)[0]
            candidate = _strip_prefixes(candidate)
            if candidate:
                project_name = candidate
                break

    user_patterns = [
        r"\bto\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$",
        r"\bto\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s+from\b",
        r"\bassign(?:ed)?\s+(?:to\s+)?([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$",
        r"\bfor\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)$",
    ]
    for pattern in user_patterns:
        match = re.search(pattern, normalized, flags=re.I)
        if match and match.group(1):
            candidate = _strip_prefixes(match.group(1))
            if candidate and candidate.lower() not in {"task", "project", "done", "review"}:
                user_name = candidate
                break

    status_patterns = [
        r"\bmove\s+.+?\s+to\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$",
        r"\bto\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$",
        r"\bstatus\s+is\s+([a-zA-Z0-9_-]+(?:\s+[a-zA-Z0-9_-]+)?)$",
    ]
    for pattern in status_patterns:
        match = re.search(pattern, normalized, flags=re.I)
        if match and match.group(1):
            status = _find_status(match.group(1)) or _clean(match.group(1)).lower()
            break

    if action == "move_task" and not status:
        status = _find_status(normalized)

    if action == "create_task" and not task_name:
        match = re.search(r"(?:create|add|make)\s+(?:a\s+)?task\s+(.+?)(?:\s+for\b|\s+in\b|\s+to\b|$)", normalized, flags=re.I)
        if match and match.group(1):
            task_name = _strip_prefixes(re.split(r"\b(?:for|in|to)\b", match.group(1), maxsplit=1, flags=re.I)[0])

    if action == "create_project" and not project_name:
        match = re.search(r"(?:create|add|make)\s+(?:a\s+)?project\s+(.+?)(?:\s+in\b|\s+for\b|\s+with\b|$)", normalized, flags=re.I)
        if match and match.group(1):
            project_name = _strip_prefixes(re.split(r"\b(?:in|for|with)\b", match.group(1), maxsplit=1, flags=re.I)[0])

    if action == "create_panel" and not panel_name:
        match = re.search(r"(?:create|add|make)\s+(?:a\s+)?panel\s+(.+?)(?:\s+in\b|\s+for\b|\s+to\b|$)", normalized, flags=re.I)
        if match and match.group(1):
            panel_name = _strip_prefixes(re.split(r"\b(?:in|for|to)\b", match.group(1), maxsplit=1, flags=re.I)[0])

    confidence = 0.82 if any([task_name, project_name, user_name, status]) else 0.55
    if action == "unknown":
        confidence = 0.25

    return {
        "action": action,
        "task_name": task_name,
        "project_name": project_name,
        "panel_name": panel_name,
        "user_name": user_name,
        "status": status,
        "confidence": round(confidence, 2),
    }


def _openai_parse(text: str) -> Optional[Dict[str, Any]]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return None

    try:
        from openai import OpenAI
    except ImportError:
        return None

    model = os.getenv("ZENTRIXA_LLM_MODEL", "gpt-4o-mini")
    client = OpenAI(api_key=api_key)

    prompt = f"""
Extract a structured command from the user text.

Supported actions:
- create_task
- create_panel
- delete_task
- assign_task
- move_task
- create_project
- delete_project
- add_member
- update_deadline
- analyze_project

Return valid JSON with these keys:
action, task_name, project_name, panel_name, user_name, status, confidence

Rules:
- Use null for missing values.
- action must be one of the supported actions or "unknown".
- Keep names exactly as spoken when possible.
- status should be normalized if obvious (done, review, in-progress, pending).
- If the command is about a panel, fill panel_name.

User text:
{text}
""".strip()

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You return only valid JSON."},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )

    content = response.choices[0].message.content or "{}"
    data = json.loads(content)

    action = str(data.get("action") or "unknown").strip()
    if action not in SUPPORTED_ACTIONS:
        action = "unknown"

    result = {
        "action": action,
        "task_name": data.get("task_name") or None,
        "project_name": data.get("project_name") or None,
        "panel_name": data.get("panel_name") or None,
        "user_name": data.get("user_name") or None,
        "status": data.get("status") or None,
        "confidence": float(data.get("confidence") or (0.9 if action != "unknown" else 0.2)),
    }

    return result


def parse_command(text: str) -> Dict[str, Any]:
    cleaned = _clean(text)
    if not cleaned:
        return {
            "action": "unknown",
            "task_name": None,
            "project_name": None,
            "user_name": None,
            "status": None,
            "confidence": 0.0,
        }

    parsed = _openai_parse(cleaned)
    if parsed:
        return parsed

    return _fallback_parse(cleaned)
