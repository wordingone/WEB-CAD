#!/usr/bin/env bash
# Pull canonical open IFC samples for Spike B mining.
# Source: buildingSMART/Sample-Test-Files (Apache-2.0 / open-license corpus).
# Schependomlaan was retired upstream in 2025 — IFC4 / IFC4x3 samples cover the
# same parametric primitives (extruded walls, columns, slabs) and are the
# current buildingSMART canonical reference.

set -euo pipefail

DATA_DIR="${1:-data/ifc}"
mkdir -p "$DATA_DIR"

BSMART_RAW="https://raw.githubusercontent.com/buildingSMART/Sample-Test-Files/main"
IOS_RAW="https://raw.githubusercontent.com/IfcOpenShell/IfcOpenShell/v0.8.0"

# Map of {local_filename : full_url}
declare -A FILES=(
  # buildingSMART canonical reference (IFC4 ReferenceView)
  ["wall-with-opening-and-window.ifc"]="${BSMART_RAW}/IFC%204.0.2.1%20%28IFC%204%29/ISO%20Spec%20-%20ReferenceView_V1.2/wall-with-opening-and-window.ifc"
  ["column-rectangle.ifc"]="${BSMART_RAW}/IFC%204.0.2.1%20%28IFC%204%29/ISO%20Spec%20-%20ReferenceView_V1.2/column-straight-rectangle-tessellation.ifc"

  # IfcOpenShell parametric corpus (Apache-2.0 / LGPL — open license)
  ["bonsai-project0-walls.ifc"]="${IOS_RAW}/src/bonsai/docs/tutorials/files/project0-walls.ifc"
  ["bonsai-project0-openings.ifc"]="${IOS_RAW}/src/bonsai/docs/tutorials/files/project0-openings.ifc"
  ["ifc2x3-demo-template.ifc"]="${IOS_RAW}/src/bonsai/bonsai/bim/data/templates/projects/IFC2X3%20Demo%20Template.ifc"
  ["ifc4-demo-template.ifc"]="${IOS_RAW}/src/bonsai/bonsai/bim/data/templates/projects/IFC4%20Demo%20Template.ifc"
  ["ifc2x3-col.ifc"]="${IOS_RAW}/src/ifcbimtester/examples/01_ifcschema_translated/IFC2X3_col.ifc"
  ["ifc4-col.ifc"]="${IOS_RAW}/src/ifcbimtester/examples/01_ifcschema_translated/IFC4_col.ifc"
  ["beam-standard-case.ifc"]="${IOS_RAW}/src/ifcopenshell-python/test/fixtures/units/beam-standard-case.ifc"
  ["simple-sweep-1.ifc"]="${IOS_RAW}/src/ifcopenshell-python/test/fixtures/geom/simple_sweep_1.ifc"
  ["simple-sweep-2.ifc"]="${IOS_RAW}/src/ifcopenshell-python/test/fixtures/geom/simple_sweep_2.ifc"

  # Bonsai / Blender-BIM demo libraries — real building geometry, parametric
  ["ifc4-demo-library.ifc"]="${IOS_RAW}/src/bonsai/bonsai/bim/data/libraries/IFC4%20Demo%20Library.ifc"
  ["ifc2x3-demo-library.ifc"]="${IOS_RAW}/src/bonsai/bonsai/bim/data/libraries/IFC2X3%20Demo%20Library.ifc"
  ["ifc4x3-demo-library.ifc"]="${IOS_RAW}/src/bonsai/bonsai/bim/data/libraries/IFC4X3%20Demo%20Library.ifc"
  ["ifc4-entourage-library.ifc"]="${IOS_RAW}/src/bonsai/bonsai/bim/data/libraries/IFC4%20Entourage%20Library.ifc"
  ["linked-aggregates.ifc"]="${IOS_RAW}/src/bonsai/test/files/linked-aggregates.ifc"
)

ok=0
fail=0
for fname in "${!FILES[@]}"; do
  url="${FILES[$fname]}"
  out="$DATA_DIR/$fname"
  if [ -f "$out" ] && [ "$(head -c 5 "$out")" = "ISO-1" ]; then
    echo "[fetch] $fname already present"
    ok=$((ok+1))
    continue
  fi
  echo "[fetch] downloading $fname"
  if curl -fLs -o "$out" "$url"; then
    # Sanity-check: IFC files start with "ISO-10303-21;"
    if [ "$(head -c 5 "$out")" = "ISO-1" ]; then
      ok=$((ok+1))
    else
      echo "[fetch] $fname downloaded but not a valid IFC (got $(head -c 30 "$out"))" >&2
      rm -f "$out"
      fail=$((fail+1))
    fi
  else
    echo "[fetch] $fname download failed" >&2
    fail=$((fail+1))
  fi
done

echo "[fetch] done. ok=$ok fail=$fail"
ls -lh "$DATA_DIR" | tail -n +2
