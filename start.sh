#!/usr/bin/env bash
# Запуск UmolkTerm.
#   UMOLK_PASSWORD=...   пароль входу (інакше згенерується при першому запуску)
#   UMOLK_HTTP=1         вимкнути HTTPS (мікрофон у браузері тоді працювати не буде)
#   UMOLK_HOSTS=a,b      додаткові IP/домени для сертифіката
set -e
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PORT="${PORT:-7681}"
if [ -z "$UMOLK_HOSTS" ] && [ ! -f data/tls/cert.pem ]; then
  PUB="$(curl -s --max-time 3 https://api.ipify.org || true)"
  [ -n "$PUB" ] && export UMOLK_HOSTS="$PUB"
fi

# Запуск локального Whisper-воркера у фоні
echo "Запуск локального Whisper воркера..."
whisper/venv/bin/python whisper/worker.py &
WHISPER_PID=$!

# Вбиваємо воркер при завершенні скрипта
trap "kill $WHISPER_PID" EXIT

exec node server.js
