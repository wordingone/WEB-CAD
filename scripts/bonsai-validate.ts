#!/usr/bin/env bun
// bonsai-validate.ts — POST an IFC file to a local Bonsai validation server.
//
// Issue #151. Bonsai (the Blender add-on for IFC) exposes its IFC validation
// surface via Blender's Python API. The "server" here is a small HTTP wrapper
// around `bonsai.bim.tool.Ifc.validate()` that listens on 127.0.0.1:8765 by
// default (see docs/runbooks/bonsai-validation.md for setup).
//
// Usage:
//   bun scripts/bonsai-validate.ts <path-to.ifc>
//
// Exit codes:
//   0  — valid (no errors; warnings allowed)
//   1  — invalid (one or more errors) OR server unreachable / bad response
//
// The server is OPTIONAL. This script does NOT install or launch it; if the
// server is down the script reports that and exits 1.

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const SERVER_URL = process.env.BONSAI_SERVER_URL || "http://127.0.0.1:8765";

type ValidateResponse = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function isValidateResponse(x: unknown): x is ValidateResponse {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.valid === "boolean" &&
    Array.isArray(o.errors) &&
    Array.isArray(o.warnings)
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    console.error("Usage: bun scripts/bonsai-validate.ts <path-to.ifc>");
    return 1;
  }
  const path = resolve(argv[0]);
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    return 1;
  }

  const buffer = readFileSync(path);
  const url = `${SERVER_URL}/validate`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": path.split(/[\\/]/).pop() || "model.ifc",
      },
      body: buffer,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Bonsai server unreachable at ${url}: ${msg}`);
    console.error("See docs/runbooks/bonsai-validation.md to install + run the validation server.");
    return 1;
  }

  if (!res.ok) {
    console.error(`Bonsai server returned ${res.status} ${res.statusText}`);
    return 1;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Bonsai server returned malformed JSON: ${msg}`);
    return 1;
  }

  if (!isValidateResponse(json)) {
    console.error("Bonsai server returned unexpected schema (need {valid, errors, warnings}).");
    return 1;
  }

  const { valid, errors, warnings } = json;
  console.log(`Bonsai validation: ${valid ? "PASS" : "FAIL"}`);
  console.log(`  errors:   ${errors.length}`);
  console.log(`  warnings: ${warnings.length}`);
  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const e of errors) console.log(`  - ${e}`);
  }
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  - ${w}`);
  }
  return valid && errors.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
