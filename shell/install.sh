#!/usr/bin/env bash
# Встановлює конфіги оболонки UmolkTerm у домашню теку
set -e
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p ~/.config
[ -f ~/.zshrc ] && cp ~/.zshrc ~/.zshrc.bak.$(date +%s)
cp "$D/starship.toml" ~/.config/starship.toml
cp "$D/starship-compact.toml" ~/.config/starship-compact.toml
cp "$D/zshrc" ~/.zshrc
echo "✓ Конфіги встановлено"
