"""
intent_engine.global_intents
=============================
Global Conversation Intent Detection layer.

Evaluates natural conversational inputs (greetings, confirmations, denials, cancellations, thanks, goodbyes) BEFORE command intent processing.

Categories:
- GLOBAL_CONFIRM  : yes, yeah, sure, okay, go ahead, proceed, do it
- GLOBAL_DENY     : no, nope, don't, do not
- GLOBAL_CANCEL   : cancel, stop, nothing, never mind, forget it, leave it, no thanks
- GLOBAL_GREETING : hi, hello, hey, good morning
- GLOBAL_THANKS   : thanks, thank you
- GLOBAL_GOODBYE  : bye, goodbye, see you
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class GlobalIntentResult:
    matched: bool
    intent:  str | None = None
    reply:   str | None = None


# Patterns for each global intent category
_CONFIRM_PATTERNS = re.compile(
    r"^(yes|yeah|yep|sure|okay|ok|go ahead|proceed|do it|confirm|that's right|correct|yup|definitely)$",
    re.IGNORECASE,
)

_DENY_PATTERNS = re.compile(
    r"^(no|nope|nah|don't|do not|negative)$",
    re.IGNORECASE,
)

_CANCEL_PATTERNS = re.compile(
    r"^(cancel|stop|nothing|never\s*mind|forget\s*it|leave\s*it|no\s*thanks|scratch\s*that|nvm|nevermind|abort|drop\s*it)$",
    re.IGNORECASE,
)

_HOW_ARE_YOU_PATTERNS = re.compile(
    r".*\b(how\s+are\s+you|how\s+you\s+doing|how\s+'?s\s+it\s+going|how\s+are\s+things)\b.*",
    re.IGNORECASE,
)

_WHO_ARE_YOU_PATTERNS = re.compile(
    r".*\b(who\s+are\s+you|what\s+is\s+your\s+name|who\s+is\s+zentrixa)\b.*",
    re.IGNORECASE,
)

_GREETING_PATTERNS = re.compile(
    r".*\b(hi|hello|hey|greetings|good\s+morning|good\s+afternoon|good\s+evening|hey\s+there|what'?s\s+up|yo)\b.*",
    re.IGNORECASE,
)

_THANKS_PATTERNS = re.compile(
    r".*\b(thanks|thank\s+you|thanks\s+a\s+lot|thank\s+you\s+so\s+much|thx|cheers)\b.*",
    re.IGNORECASE,
)

_GOODBYE_PATTERNS = re.compile(
    r".*\b(bye|goodbye|see\s+you|see\s+ya|catch\s+you\s+later|cya|exit|quit|close)\b.*",
    re.IGNORECASE,
)


class GlobalIntentDetector:
    """Detects global conversational intents before command matching."""

    @classmethod
    def detect(cls, text: str) -> GlobalIntentResult:
        cleaned = text.strip().lower()
        if not cleaned:
            return GlobalIntentResult(matched=False)

        # 1. How are you / small talk
        if _HOW_ARE_YOU_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_HOW_ARE_YOU",
                reply="Hello! I'm doing great, thank you! I'm ready to help you manage your tasks and projects.",
            )

        # 2. Who are you / identity
        if _WHO_ARE_YOU_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_WHO_ARE_YOU",
                reply="I am Zentrixa, your AI project management assistant! I help you create tasks, assign work, and track team progress.",
            )

        # 3. Cancel / Nothing / Never mind
        if _CANCEL_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_CANCEL",
                reply="Cancelled. Let me know if you need anything else.",
            )

        # 4. Confirmation
        if _CONFIRM_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_CONFIRM",
                reply="Confirmed. Processing your request.",
            )

        # 5. Denial
        if _DENY_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_DENY",
                reply="No problem. Action cancelled.",
            )

        # 6. Greeting
        if _GREETING_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_GREETING",
                reply="Hello! How can I help you with your tasks or projects today?",
            )

        # 7. Thanks
        if _THANKS_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_THANKS",
                reply="You're welcome! Let me know if you need anything else.",
            )

        # 8. Goodbye
        if _GOODBYE_PATTERNS.search(cleaned):
            return GlobalIntentResult(
                matched=True,
                intent="GLOBAL_GOODBYE",
                reply="Goodbye! Have a great day.",
            )

        return GlobalIntentResult(matched=False)
