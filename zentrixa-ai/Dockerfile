FROM python:3.10-slim

# ── System dependencies ────────────────────────────────────────────────────────
# ffmpeg: required by faster-whisper to decode audio (webm, mp4, wav, ogg …)
# libsndfile1: required by soundfile (faster-whisper dependency)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── CPU-only PyTorch ───────────────────────────────────────────────────────────
# Install before requirements.txt to use the CPU wheel index.
# This saves ~4 GB vs the default CUDA build.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# ── Python dependencies ────────────────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Pre-download Whisper model at build time ───────────────────────────────────
# Bakes the model weights into the image so the first request is not slow.
# Uses the same model name as the WHISPER_MODEL env var default (base).
ARG WHISPER_MODEL=base
RUN python -c "\
from faster_whisper import WhisperModel; \
WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8'); \
print('Whisper model cached.')"

# ── Application code ───────────────────────────────────────────────────────────
COPY . .

# Remove Python cache files to keep the image clean
RUN find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
RUN find . -name "*.pyc" -delete 2>/dev/null || true

EXPOSE 8001

# ── Health check ───────────────────────────────────────────────────────────────
# Longer start-period: the model loads synchronously during startup.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')" || exit 1

# ── Run ────────────────────────────────────────────────────────────────────────
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8001"]
