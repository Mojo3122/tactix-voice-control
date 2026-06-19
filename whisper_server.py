#!/usr/bin/env python3
"""
TactixMCT — Offline Whisper Speech-to-Text Server
Runs locally on the Command Center PC. No internet needed.

Usage: python whisper_server.py
Endpoint: POST http://localhost:9200/transcribe  (audio file)
Health:   GET  http://localhost:9200/health
"""

import os
import json
import tempfile
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("WHISPER_PORT", "9200"))
# Options: tiny, base, small, medium, large-v3. Override with WHISPER_MODEL.
# "small" gives the best accuracy/speed balance for short commands on CPU.
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")

print("=" * 54)
print("  TactixMCT — Whisper Speech Server (Offline)")
print("=" * 54)
print(f"  Model:     {MODEL_SIZE}")
print(f"  Endpoint:  http://0.0.0.0:{PORT}/transcribe")
print()
print("  Loading Whisper model (first run downloads ~150MB)...")

from faster_whisper import WhisperModel

model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
print(f"  Whisper '{MODEL_SIZE}' model loaded and ready!")
print()


class WhisperHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/transcribe":
            self._handle_transcribe()
        else:
            self._json({"error": "not found"}, 404)

    def do_GET(self):
        if self.path == "/health" or self.path == "/":
            self._json({
                "service": "whisper_server",
                "model": MODEL_SIZE,
                "status": "ready",
            })
        else:
            self._json({"error": "not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _handle_transcribe(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._json({"error": "No audio data"}, 400)
                return

            audio_data = self.rfile.read(content_length)

            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
                f.write(audio_data)
                temp_path = f.name

            try:
                start = time.time()
                segments, info = model.transcribe(
                    temp_path,
                    language="en",
                    beam_size=3,
                    vad_filter=True,
                )

                text_parts = []
                for segment in segments:
                    text_parts.append(segment.text.strip())

                transcript = " ".join(text_parts).strip()
                elapsed = round(time.time() - start, 2)

                print(f"  Transcribed ({elapsed}s): \"{transcript}\"")

                self._json({
                    "text": transcript,
                    "language": info.language,
                    "duration": round(info.duration, 2),
                    "processing_time": elapsed,
                })
            finally:
                os.unlink(temp_path)

        except Exception as e:
            print(f"  Error: {e}")
            self._json({"error": str(e)}, 500)

    def _json(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), WhisperHandler)
    print(f"  Listening on port {PORT}")
    print(f"  POST audio to http://localhost:{PORT}/transcribe")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Shutting down...")
        server.server_close()