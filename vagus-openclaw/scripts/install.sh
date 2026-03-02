#!/usr/bin/env bash
set -euo pipefail

# VAGUS Skill Installer
# Installs the skill to the user's OpenClaw skills directory and sets up dependencies.

SKILL_NAME="vagus"
INSTALL_DIR="${HOME}/.openclaw/skills/${SKILL_NAME}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing VAGUS skill to ${INSTALL_DIR}"

if [ -d "${INSTALL_DIR}" ]; then
  echo "    Existing install found, replacing..."
  rm -rf "${INSTALL_DIR}"
fi

mkdir -p "$(dirname "${INSTALL_DIR}")"
cp -r "${SCRIPT_DIR}/.." "${INSTALL_DIR}"

echo "==> Installing npm dependencies..."
cd "${INSTALL_DIR}/scripts"
npm install --silent

echo ""
echo "VAGUS skill installed to ${INSTALL_DIR}"
echo ""
echo "Next steps:"
echo "1. Pair your device:"
echo "   node ${INSTALL_DIR}/scripts/vagus-connect.js pair <CODE>"
echo ""
echo "2. Set your agent name (replace <NAME> with your identity):"
echo "   node ${INSTALL_DIR}/scripts/vagus-connect.js call agent/set_name '{\"name\":\"<NAME>\"}'"
echo ""
echo "3. Verify:"
echo "   node ${INSTALL_DIR}/scripts/vagus-connect.js status"
echo ""
echo "4. Start the managed subscription service when you want persistent field streams:"
echo "   node ${INSTALL_DIR}/scripts/vagus-manager.js"
echo "   node ${INSTALL_DIR}/scripts/vagus-manager.js status"
echo ""
echo "For full docs, see ${INSTALL_DIR}/README.md"
echo ""
