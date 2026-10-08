#!/usr/bin/env bash
# UmolkTerm — встановлення браузерної версії однією командою (Debian / Ubuntu).
#
#   ./deploy/install.sh [опції]
#
#   --port N            порт (за замовчуванням 7681)
#   --password PASS     пароль входу (інакше згенерується)
#   --no-whisper        не ставити локальний Whisper (голос через браузер / OpenAI)
#   --model NAME        модель Whisper: small-q5_1 (≈180 MB, за замовч.) | large-v3-q5_0 (≈1.1 GB)
#   --shell             поставити zsh-конфіг + Starship prompt (shell/install.sh)
#   --no-service        не створювати systemd-сервіс (запуск вручну: ./start.sh)
#   --name NAME         ім'я systemd-сервісу (за замовч. umolkterm)
set -euo pipefail

PORT=7681
PASSWORD=""
WHISPER=1
MODEL="small-q5_1"
SHELLCFG=0
SERVICE=1
NAME="umolkterm"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --no-whisper) WHISPER=0; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    --shell) SHELLCFG=1; shift ;;
    --no-service) SERVICE=0; shift ;;
    --name) NAME="$2"; shift 2 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    *) echo "Невідома опція: $1" >&2; exit 1 ;;
  esac
done

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
RUN_USER="$(id -un)"
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

say() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }

# ---------- 1. Системні пакети ----------
say "Системні пакети"
PKGS="curl ca-certificates openssl build-essential python3 ffmpeg zsh"
[ "$WHISPER" = 1 ] && PKGS="$PKGS python3-venv python3-dev"
as_root apt-get update -qq
# shellcheck disable=SC2086
as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $PKGS >/dev/null

# ---------- 2. Node.js >= 20 ----------
NODE_MAJOR=0
command -v node >/dev/null && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Встановлення Node.js 20 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | as_root bash - >/dev/null
  as_root apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

# ---------- 3. npm-залежності (node-pty збирається під цю машину) ----------
say "npm-залежності"
npm ci --omit=dev --no-audit --no-fund

# ---------- 4. Whisper ----------
if [ "$WHISPER" = 1 ]; then
  say "Локальний Whisper ($MODEL)"
  [ -x whisper/venv/bin/python ] || python3 -m venv whisper/venv
  whisper/venv/bin/pip install -q --upgrade pip
  whisper/venv/bin/pip install -q pywhispercpp numpy
  echo "Модель завантажиться автоматично при першому старті."
fi

# ---------- 5. Пароль і .env ----------
say "Конфігурація"
PW_SET=0
if [ -n "$PASSWORD" ]; then
  PW_SET=1
elif [ ! -f data/auth.json ]; then
  PASSWORD="$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-14)"
  PW_SET=1
fi
# Пароль зберігається лише як scrypt-хеш у data/auth.json (2FA не скидається)
[ "$PW_SET" = 1 ] && node deploy/set-password.js "$PASSWORD"
umask 077
{
  echo "PORT=$PORT"
  echo "UMOLK_WHISPER_MODEL=$MODEL"
  # Зберігаємо ключі API та інші налаштування, якщо вони вже були
  [ -f .env ] && grep -E '^(OPENAI_API_KEY|GEMINI_API_KEY|UMOLK_HOSTS|UMOLK_HTTP)=' .env || true
} > .env.new
mv .env.new .env
umask 022
chmod +x start.sh

# ---------- 6. zsh + Starship (опційно) ----------
if [ "$SHELLCFG" = 1 ]; then
  say "zsh + Starship"
  command -v starship >/dev/null || curl -fsSL https://starship.rs/install.sh | as_root sh -s -- -y >/dev/null
  as_root apt-get install -y -qq zsh-autosuggestions zsh-syntax-highlighting >/dev/null || true
  ./shell/install.sh
fi

# ---------- 7. systemd ----------
if [ "$SERVICE" = 1 ] && command -v systemctl >/dev/null; then
  say "systemd-сервіс $NAME"
  as_root tee "/etc/systemd/system/$NAME.service" >/dev/null <<EOF
[Unit]
Description=UmolkTerm web terminal ($NAME)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$(getent passwd "$RUN_USER" | cut -d: -f6)
ExecStart=$APP_DIR/start.sh
Restart=always
RestartSec=3
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable --now "$NAME" >/dev/null
  sleep 3
  systemctl is-active --quiet "$NAME" && echo "Сервіс запущено" || { echo "Сервіс не стартував:"; as_root journalctl -u "$NAME" -n 30 --no-pager; exit 1; }
fi

PUB="$(curl -s --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}')"
cat <<EOF

=======================================================
 🦇 UmolkTerm встановлено
    Адреса:  https://$PUB:$PORT
EOF
if [ "$PW_SET" = 1 ]; then echo "    Пароль:  $PASSWORD"; else echo "    Пароль:  без змін (змінити: node deploy/set-password.js 'новий')"; fi
cat <<EOF
 Самопідписаний сертифікат — один раз прийміть попередження браузера.
 Не забудьте відкрити порт $PORT у фаєрволі / security group.
EOF
if [ "$SERVICE" = 1 ]; then
  echo " Керування: sudo systemctl {status|restart|stop} $NAME"
  echo " Логи:      sudo journalctl -u $NAME -f"
else
  echo " Запуск:    ./start.sh"
fi
echo "======================================================="
