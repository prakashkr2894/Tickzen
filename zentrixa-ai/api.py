"""
Zentrixa AI — FastAPI entry point
==================================
Runs two services in a single process:

1. Voice Service     POST /voice/transcribe
   Faster-Whisper singleton — transcription only. Never calls the LLM.

2. Intent Engine     POST /intent/classify
   Plugin-based Hybrid Intent Engine. Confidence-gated: local or LLM.

3. Legacy parse API  POST /ai/parse  /zentrixa
   Kept unchanged for backward compatibility.

Health probes
-------------
GET /health   — always 200 (process alive)
GET /ready    — 200 once Whisper model and intent engine are loaded
GET /live     — always 200 (alias for k8s liveness)
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from ai_parser import parse_command
from intent_engine import IntentEngine
from intent_engine.plugins.task_manager import TaskManagerPlugin
from voice_service import TranscriptionError, VoiceService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan — load everything once at startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("=== Zentrixa AI starting up ===")

    # 1. Faster-Whisper (CPU, int8) — loads model from disk or cache
    #    Wrapped in try/except: if faster-whisper is not installed in the
    #    current env the server still starts; /voice/transcribe returns 503.
    try:
        app.state.voice = VoiceService()
    except Exception as exc:
        logger.warning(
            "VoiceService failed to load (%s). "
            "Install faster-whisper: pip install faster-whisper. "
            "/voice/transcribe will return 503 until the package is available.",
            exc,
        )
        app.state.voice = None

    # 2. Intent Engine + plugins
    #    Thresholds are read from env vars inside IntentEngine.__init__():
    #      INTENT_DIRECT_THRESHOLD  (default 0.90)
    #      INTENT_LLM_THRESHOLD     (default 0.60)
    engine = IntentEngine()
    engine.register(TaskManagerPlugin())
    # Future integrations — one line each:
    # engine.register(KubernetesPlugin())
    # engine.register(DockerPlugin())
    app.state.engine = engine

    logger.info(
        "Startup complete | whisper=%s | plugins=%s",
        app.state.voice.model_name if app.state.voice else "NOT LOADED",
        engine.plugin_names,
    )
    yield
    logger.info("=== Zentrixa AI shutting down ===")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Zentrixa AI",
    version="2.0.0",
    description="Voice transcription + Hybrid Intent Engine",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Health probes
# ---------------------------------------------------------------------------

@app.get("/health", tags=["probes"])
def health():
    """Basic health — process is alive."""
    return {"status": "ok"}


@app.get("/live", tags=["probes"])
def live():
    """Kubernetes liveness probe."""
    return {"status": "live"}


@app.get("/ready", tags=["probes"])
def ready(request: Request):
    """
    Kubernetes readiness probe.
    Returns 503 until VoiceService and IntentEngine are loaded.
    """
    voice: VoiceService | None = getattr(request.app.state, "voice", None)
    engine: IntentEngine | None = getattr(request.app.state, "engine", None)

    if engine is None:
        raise HTTPException(status_code=503, detail="Intent engine not ready")

    voice_status = voice.model_name if (voice and voice.is_ready) else "not loaded"
    return {
        "status":  "ready",
        "model":   voice_status,
        "plugins": engine.plugin_names,
    }


# ---------------------------------------------------------------------------
# Voice transcription
# ---------------------------------------------------------------------------

@app.post("/voice/transcribe", tags=["voice"])
async def voice_transcribe(request: Request, audio: UploadFile = File(...)):
    """
    Transcribe audio using Faster-Whisper.

    Accepts any audio format supported by ffmpeg (webm, mp4, wav, ogg …).
    Returns { text, language, duration_ms, word_count }.
    Never calls the LLM. Never executes actions.
    """
    voice: VoiceService | None = request.app.state.voice

    if voice is None or not voice.is_ready:
        raise HTTPException(
            status_code=503,
            detail="Voice service unavailable. Run: pip install faster-whisper",
        )

    audio_bytes = await audio.read()
    if not audio_bytes or len(audio_bytes) < 100:
        return {
            "text":        "",
            "language":    "en",
            "duration_ms": 0,
            "word_count":  0,
        }

    try:
        result = voice.transcribe(audio_bytes, filename=audio.filename or "audio.webm")
    except TranscriptionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "text":        result.text,
        "language":    result.language,
        "duration_ms": result.duration_ms,
        "word_count":  result.word_count,
    }


# ---------------------------------------------------------------------------
# Intent classification
# ---------------------------------------------------------------------------

class IntentRequest(BaseModel):
    text:    str = Field(..., min_length=1)
    context: dict = Field(default_factory=dict)


@app.post("/intent/classify", tags=["intent"])
def intent_classify(body: IntentRequest, request: Request):
    """
    Classify text with the Hybrid Intent Engine.

    Returns ClassificationResult:
    {
      "intent":     "CREATE_TASK" | null,
      "plugin":     "task_manager" | null,
      "confidence": 0.94,
      "entities":   { "title": "Fix Login", "assignee": "Rahul" },
      "route":      "local" | "llm",
      "transcript": "<original text>",
      "elapsed_ms": 12
    }
    """
    engine: IntentEngine = request.app.state.engine
    return engine.classify(body.text)


# ---------------------------------------------------------------------------
# Legacy parse API (kept unchanged for backward compatibility)
# ---------------------------------------------------------------------------

class ZentrixaRequest(BaseModel):
    text: str = Field(..., min_length=1)


@app.post("/ai/parse", tags=["legacy"])
def parse_ai_command(body: ZentrixaRequest):
    """Legacy intent parser — kept for backward compatibility."""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    return parse_command(text)


@app.post("/zentrixa", tags=["legacy"])
def zentrixa(body: ZentrixaRequest):
    """Legacy alias — kept for backward compatibility."""
    return parse_ai_command(body)
