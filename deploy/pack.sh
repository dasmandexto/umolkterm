#!/usr/bin/env bash
# Пакує браузерну версію в архів для перенесення на інший сервер:
#   ./deploy/pack.sh  →  dist/umolkterm-web.tar.gz
# На новому сервері:
#   tar xzf umolkterm-web.tar.gz && cd umolkterm && ./deploy/install.sh
# Без data/, .env, node_modules, Whisper-моделей та Android-проєкту.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p dist
git ls-files -co --exclude-standard \
  | grep -vE '^(android/|dist/)' \
  | tar czf dist/umolkterm-web.tar.gz --transform 's,^,umolkterm/,' -T -
ls -lh dist/umolkterm-web.tar.gz
