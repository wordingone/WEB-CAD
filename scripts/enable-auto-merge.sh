#!/usr/bin/env bash
# Enable auto-merge on the WEB-CAD GitHub repo (WEB-CAD#53).
# Run once by a repo admin after initial clone / if the setting gets reset.
#
# Requires: gh auth login with admin scope on wordingone/WEB-CAD
set -e
gh api -X PATCH repos/wordingone/WEB-CAD --field allow_auto_merge=true --jq '.allow_auto_merge' \
  | grep -q "^true$" && echo "auto-merge enabled on wordingone/WEB-CAD" || { echo "FAILED"; exit 1; }
