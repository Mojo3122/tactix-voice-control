# ════════════════════════════════════════════════════════════════
#  TactixMCT — Offline Whisper Speech-to-Text (self-contained)
#  The voice model is baked into the image during build, so at
#  RUNTIME this needs NO internet. Build once (downloads the model),
#  then voice commands work fully offline forever.
# ════════════════════════════════════════════════════════════════
FROM python:3.11-slim

# ffmpeg/libav lets faster-whisper decode the browser's webm/opus audio.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir faster-whisper

# Which model to bake in (tiny|base|small|medium|large-v3). "small" is a good
# CPU default for short commands. Override: --build-arg WHISPER_MODEL=base
ARG WHISPER_MODEL=small
ENV WHISPER_MODEL=${WHISPER_MODEL}

# Pre-download + cache the model INTO the image (needs internet at build time only).
RUN python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')"

# After this point, never touch the network for model files — pure offline.
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

COPY whisper_server.py .

EXPOSE 9200
CMD ["python", "whisper_server.py"]
