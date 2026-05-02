"""Decode base64-encoded export blobs from stdin and write each to
submission/screenshots/v3-export-samples/wall.<key>.

Usage:
    python scripts/decode-blobs.py < blobs.json
"""
import base64
import json
import os
import sys

OUT = "submission/screenshots/v3-export-samples"
os.makedirs(OUT, exist_ok=True)
data = json.load(sys.stdin)
for fmt, b64 in data.items():
    path = os.path.join(OUT, f"wall.{fmt}")
    raw = base64.b64decode(b64)
    with open(path, "wb") as f:
        f.write(raw)
    print(f"wrote {path} ({len(raw)} bytes)")
