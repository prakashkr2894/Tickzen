"""
voice_service.py
================
Self-hosted transcription using Faster-Whisper.

Responsibilities
----------------
- Load WhisperModel ONCE at startup (singleton pattern).
- Transcribe raw audio bytes for every request.
- Return structured TranscriptResult.
- NEVER communicate with the LLM.
- NEVER execute backend actions.
- NEVER log raw audio.

Configuration (env vars)
------------------------
WHISPER_MODEL        : tiny | base | small  (default: base)
WHISPER_COMPUTE_TYPE : int8 | float16       (default: int8)
WHISPER_LANGUAGE     : force language code  (default: None = auto-detect)
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class TranscriptResult:
    text: str
    language: str
    duration_ms: int
    word_count: int


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class TranscriptionError(RuntimeError):
    """Raised when audio cannot be transcribed."""


# ---------------------------------------------------------------------------
# Singleton voice service
# ---------------------------------------------------------------------------

class VoiceService:
    """
    Thread-safe singleton wrapper around faster_whisper.WhisperModel.

    Usage
    -----
    service = VoiceService()          # model loads now
    result  = service.transcribe(audio_bytes)
    """

    _instance: VoiceService | None = None
    _lock: threading.Lock = threading.Lock()

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def __init__(
        self,
        model_name: str | None = None,
        compute_type: str | None = None,
        language: str | None = None,
    ) -> None:
        self._model_name    = model_name    or os.getenv("WHISPER_MODEL", "base")
        self._compute_type  = compute_type  or os.getenv("WHISPER_COMPUTE_TYPE", "int8")
        self._language      = language      or os.getenv("WHISPER_LANGUAGE") or None
        self._model         = None
        self._model_lock    = threading.Lock()
        self._ready         = False
        self._load()

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------

    def _load(self) -> None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper is not installed. "
                "Run: pip install faster-whisper"
            ) from exc

        logger.info(
            "Loading Whisper model '%s' (compute_type=%s) …",
            self._model_name, self._compute_type,
        )
        t0 = time.monotonic()
        self._model = WhisperModel(
            self._model_name,
            device="cpu",
            compute_type=self._compute_type,
        )
        elapsed = int((time.monotonic() - t0) * 1000)
        self._ready = True
        logger.info("Whisper model ready in %d ms.", elapsed)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def is_ready(self) -> bool:
        return self._ready

    @property
    def model_name(self) -> str:
        return self._model_name

    def transcribe(self, audio_bytes: bytes, filename: str = "audio.webm") -> TranscriptResult:
        """
        Transcribe audio bytes to text.

        Parameters
        ----------
        audio_bytes : raw audio bytes (webm / mp4 / wav — any ffmpeg format)
        filename    : hint for ffmpeg about the container format

        Returns
        -------
        TranscriptResult with text, language, duration_ms, word_count

        Raises
        ------
        TranscriptionError  if transcription fails or produces empty output
        """
        if not self._ready or self._model is None:
            raise TranscriptionError("Whisper model is not loaded yet.")

        t0 = time.monotonic()

        # Write to a named temp file — faster-whisper needs a file path
        suffix = os.path.splitext(filename)[1] or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            initial_prompt = (
                "TickZen, Zentrixa, Vartalap, MedTrackFit, create project, create task, "
                "assign task, move task, sprint, dashboard, panel, status, deadline."
            )
            with self._model_lock:
                segments, info = self._model.transcribe(
                    tmp_path,
                    language=self._language or "en",
                    beam_size=5,
                    best_of=5,
                    patience=1.0,
                    temperature=(0.0, 0.2, 0.4),
                    initial_prompt=initial_prompt,
                    condition_on_previous_text=False,
                    vad_filter=False,
                )
                text = " ".join(seg.text.strip() for seg in segments).strip()
        except Exception as exc:
            raise TranscriptionError(f"Transcription failed: {exc}") from exc
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        elapsed = int((time.monotonic() - t0) * 1000)

        result = TranscriptResult(
            text=text,
            language=getattr(info, "language", None) or "en",
            duration_ms=elapsed,
            word_count=len(text.split()) if text else 0,
        )

        # Log metrics — never log raw audio or full transcript
        logger.info(
            "Transcription done | words=%d lang=%s duration_ms=%d",
            result.word_count, result.language, result.duration_ms,
        )

        return result
