#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Load nvm if available and .nvmrc exists
if [[ -f ".nvmrc" ]]; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    source "$HOME/.nvm/nvm.sh"
    nvm use 2>/dev/null || true
  fi
fi

exec node dist/index.js "$@"
