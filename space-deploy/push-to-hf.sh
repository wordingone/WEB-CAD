#!/usr/bin/env bash
# Deploy gemma-architect to HuggingFace Spaces.
# Requires: HF_TOKEN env var set to a write-scoped HF token
#           (Settings → Access Tokens → New token → Write scope)
# Usage: HF_TOKEN=hf_xxx bash push-to-hf.sh [space-name]
#   space-name defaults to "wordingone/gemma-architect"

set -euo pipefail

SPACE="${1:-wordingone/gemma-architect}"
SPACE_URL="https://huggingface.co/spaces/${SPACE}"
GIT_URL="https://user:${HF_TOKEN}@huggingface.co/spaces/${SPACE}"

if [ -z "${HF_TOKEN:-}" ]; then
  echo "ERROR: HF_TOKEN env var not set"
  echo "Get one at https://huggingface.co/settings/tokens (Write scope)"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Create Space if it doesn't exist
echo "Creating Space ${SPACE} (or no-op if exists)..."
curl -s -o /dev/null -w "%{http_code}" \
  -X POST "https://huggingface.co/api/repos/create" \
  -H "Authorization: Bearer ${HF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"space\",\"name\":\"$(echo $SPACE | cut -d/ -f2)\",\"sdk\":\"docker\",\"private\":false}" \
  || true
echo ""

# Git push
if [ ! -d .git ]; then
  git init
  git remote add hf "$GIT_URL"
fi

git add -A
git commit -m "deploy: gemma-architect static demo" --allow-empty
git push hf HEAD:main --force

echo ""
echo "Deployed to: ${SPACE_URL}"
