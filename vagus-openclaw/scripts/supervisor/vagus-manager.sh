#!/bin/bash

set -euo pipefail

VAGUS_DIR="${HOME}/.openclaw/skills/vagus/scripts"
cd "$VAGUS_DIR"

if [ ! -d "node_modules" ]; then
  npm install
fi

exec node vagus-manager.js "$@"
