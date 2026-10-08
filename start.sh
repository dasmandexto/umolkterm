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

# Завантажуємо .env (UMOLK_PASSWORD, UMOLK_WHISPER_MODEL, ключі API тощо), якщо є
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# Локальний Whisper-воркер — лише якщо встановлено (install.sh без --no-whisper)
if [ -x whisper/venv/bin/python ]; then
  echo "Запуск локального Whisper воркера..."
  whisper/venv/bin/python whisper/worker.py &
  WHISPER_PID=$!
  # Вбиваємо воркер при завершенні скрипта
  trap 'kill $WHISPER_PID 2>/dev/null' EXIT
  node server.js
else
  echo "Whisper не встановлено — голос працюватиме через браузер або OpenAI."
  exec node server.js
fi
