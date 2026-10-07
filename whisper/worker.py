#!/usr/bin/env python3
"""
UmolkTerm — локальний Whisper-воркер (whisper.cpp через pywhispercpp).

Модель завантажується в пам'ять один раз, далі розпізнавання йде без затримки старту.
Слухає тільки 127.0.0.1; Node-сервер UmolkTerm проксіює запити після авторизації.

POST /transcribe?lang=uk   тіло: аудіо (webm/ogg/mp4/wav — декодується через ffmpeg)
GET  /health
"""
import os
import sys
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np
from pywhispercpp.model import Model

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models")
MODEL_NAME = os.environ.get("UMOLK_WHISPER_MODEL", "small-q5_1")
PORT = int(os.environ.get("UMOLK_WHISPER_PORT", "7682"))
THREADS = int(os.environ.get("UMOLK_WHISPER_THREADS", str(min(8, os.cpu_count() or 4))))
MAX_BYTES = 20 * 1024 * 1024

os.makedirs(MODEL_DIR, exist_ok=True)
print(f"[whisper] завантаження моделі {MODEL_NAME} (потоків: {THREADS})…", flush=True)
model = Model(MODEL_NAME, models_dir=MODEL_DIR, n_threads=THREADS,
              print_realtime=False, print_progress=False, print_timestamps=False)
lock = threading.Lock()  # модель не потокобезпечна
print("[whisper] готово", flush=True)

PROMPT = "Термінальні команди Linux, bash, zsh, ssh, docker, apt, systemctl, українською мовою."


def decode_audio(raw: bytes) -> np.ndarray:
    """Будь-який аудіоформат → float32 mono 16 кГц."""
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0",
         "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
        input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
    )
    if p.returncode != 0 or not p.stdout:
        raise ValueError("не вдалося декодувати аудіо: " + p.stderr.decode(errors="ignore")[:200])
    return np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._json(200, {"ok": True, "model": MODEL_NAME})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > MAX_BYTES:
                return self._json(400, {"error": "некоректний розмір аудіо"})
            audio = decode_audio(self.rfile.read(n))
            if len(audio) < 16000 * 0.3:
                return self._json(200, {"text": ""})
            lang = parse_qs(url.query).get("lang", ["uk"])[0][:5]
            with lock:
                segs = model.transcribe(audio, language=lang, initial_prompt=PROMPT,
                                        no_context=True, suppress_blank=True)
            text = " ".join(s.text.strip() for s in segs).strip()
            self._json(200, {"text": text})
        except Exception as e:
            self._json(500, {"error": str(e)})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
