#!/usr/bin/env bash
# Pull canonical open IFC samples for Spike B mining.
# CC-BY 4.0 corpus only — see docs/data-license-audit.md for provenance.

set -euo pipefail

DATA_DIR="${1:-data/ifc}"
mkdir -p "$DATA_DIR"

# Schependomlaan — IFC2x3 housing project, ThatOpen demo standard.
# CC-BY 4.0; ~1k elements.
SCHEPENDOMLAAN_URL="https://github.com/openBIMstandards/DataSetSchependomlaan/raw/master/Design%20model%20IFC/IFC%20Schependomlaan.ifc"

if [ ! -f "$DATA_DIR/Schependomlaan.ifc" ]; then
  echo "[fetch] downloading Schependomlaan.ifc"
  curl -L -o "$DATA_DIR/Schependomlaan.ifc" "$SCHEPENDOMLAAN_URL"
else
  echo "[fetch] Schependomlaan.ifc already present"
fi

# Duplex — buildingSMART canonical small house, IFC2x3.
# CC-BY-SA 4.0 (some sources) — confirm before redistribution.
DUPLEX_URL="https://github.com/buildingSMART/Sample-Test-Files/raw/master/IFC%202x3/Duplex%20Apartment/Duplex_A_20110907.ifc"

if [ ! -f "$DATA_DIR/Duplex.ifc" ]; then
  echo "[fetch] downloading Duplex.ifc"
  curl -L -o "$DATA_DIR/Duplex.ifc" "$DUPLEX_URL" || echo "[fetch] Duplex download failed; skipping"
else
  echo "[fetch] Duplex.ifc already present"
fi

echo "[fetch] done. $(ls -lh "$DATA_DIR" | tail -n +2)"
