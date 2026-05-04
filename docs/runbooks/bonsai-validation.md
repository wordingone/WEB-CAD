# Bonsai IFC Validation — Runbook

Issue: #151 closed. The gemma-architect side (web client + CLI) ships and
is wired to call the server when present, degrading silently when it is
not. The Python validation server is intentionally user-deployed — we
provide a sample below rather than bundling a binary, because the path
requires a local Blender + Bonsai install.

## What this gives you

When a local Bonsai validation server is running on `127.0.0.1:8765`:

- `bun scripts/bonsai-validate.ts <path.ifc>` — CLI: POST a file, print
  pass/fail with a list of errors and warnings.
- The web export drawer shows a "Validate via Bonsai" link below the IFC
  button. Click it after exporting an IFC and a results modal appears.

When the server is not running:

- The CLI prints a one-line error and exits with code 1.
- The web drawer does **not** show the link at all (silent fallback).

## Endpoints expected on the server

| Method | Path        | Body                    | Response                                       |
|--------|-------------|-------------------------|------------------------------------------------|
| GET    | `/health`   | —                       | 200 OK with any (or no) body                   |
| POST   | `/validate` | raw IFC bytes (octet)   | `{ "valid": bool, "errors": [...], "warnings": [...] }` |

The `validateIFC` web client and the `bonsai-validate.ts` CLI both POST raw
bytes (`content-type: application/octet-stream`). The server is responsible
for parsing them as STEP-21 SPF and dispatching to Bonsai's validation
surface.

## Install (one-time)

1. **Blender** ≥ 4.2 — https://www.blender.org/download/
2. **Bonsai add-on** — https://bonsai.bim/install/
   - Open Blender → Edit → Preferences → Add-ons → search "Bonsai".
   - Install from disk if needed (the add-on ZIP from bonsai.bim).
   - Enable the add-on.
3. **A Python interpreter** that can `import bonsai` — the simplest path is
   to run the server from inside Blender's bundled Python (Blender ships a
   compatible interpreter at `<Blender>/<version>/python/bin/python`).

## Run the server (sample)

Save the script below as `scripts/bonsai-server.py` (NOT in this repo;
this file is a runbook only). Then start it from a Blender-aware shell:

```bash
# Path to Blender's bundled Python on Windows:
"C:\Program Files\Blender Foundation\Blender 4.2\4.2\python\bin\python.exe" scripts/bonsai-server.py
```

The sample server is intentionally small — under 50 lines — and intended
as a starting point, not a production tool.

```python
"""bonsai-server.py — minimal HTTP wrapper around bonsai IFC validation.

Listens on 127.0.0.1:8765. Endpoints match the gemma-architect contract:
  GET  /health   -> 200 OK
  POST /validate -> {valid, errors[], warnings[]} for the body's IFC bytes
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from tempfile import NamedTemporaryFile

# Bonsai imports require Blender's Python; running outside Blender raises
# ImportError and the server simply won't start (which is the correct
# behavior — the gemma-architect side will degrade gracefully).
import ifcopenshell
import ifcopenshell.validate

HOST, PORT = "127.0.0.1", 8765


def _validate_bytes(ifc_bytes: bytes) -> dict:
    with NamedTemporaryFile(suffix=".ifc", delete=False) as tmp:
        tmp.write(ifc_bytes)
        tmp.flush()
        path = tmp.name
    model = ifcopenshell.open(path)
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(model, logger)
    errors = [str(m) for m in logger.statements if m.get("level") == "ERROR"]
    warnings = [str(m) for m in logger.statements if m.get("level") == "WARNING"]
    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):  # noqa: N802
        if self.path != "/validate":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        try:
            payload = _validate_bytes(body)
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode("utf-8"))
        except Exception as e:  # any parse / validate failure
            self.send_response(500)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "valid": False,
                "errors": [f"server error: {e}"],
                "warnings": [],
            }).encode("utf-8"))


if __name__ == "__main__":
    print(f"bonsai-server listening on http://{HOST}:{PORT}")
    HTTPServer((HOST, PORT), Handler).serve_forever()
```

## Notes

- The sample uses `ifcopenshell.validate` directly. Bonsai itself (Blender
  add-on) wraps this and adds a few BIM-flavored checks on top
  (`bonsai.bim.tool.Ifc.validate()` for the in-memory case). For pure
  schema + geometry validation, `ifcopenshell.validate` is sufficient and
  doesn't require Blender to be open.
- If you want Bonsai's BIM-specific checks, run from inside Blender via
  `blender --background --python bonsai-server.py`. Bonsai's tool surface
  is documented at https://bonsai.bim/.
- The server is local-only by design (binds to 127.0.0.1). Do **not**
  expose it on a network interface; the validate endpoint accepts arbitrary
  bytes and parses them as STEP-21.
- `BONSAI_SERVER_URL` env var overrides the default for the CLI; the web
  client honors `globalThis.__BONSAI_SERVER_URL__` for the same purpose.

## How gemma-architect calls it

- CLI: `scripts/bonsai-validate.ts` (POST /validate, exits 0 on PASS, 1 otherwise).
- Web: `web/src/bonsai-client.ts` exports `isBonsaiAvailable()` and
  `validateIFC(buffer)`. The export drawer probes availability on open and
  conditionally renders the validate link.

If the server is down, the CLI prints a single error line and exits 1; the
web UI hides the link entirely. There are no toasts or `console.error`
side effects from the missing-server path — the absence of the server is a
normal operating state, not a fault.
