import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Finding = {
  file: string;
  line: number;
  text: string;
};

type PatternSpec = {
  key: string;
  label: string;
  pattern: RegExp;
};

const ROOT = process.cwd();
const SRC_ROOT = join(ROOT, "web", "src");

const PATTERNS: PatternSpec[] = [
  {
    key: "three_mesh_construction",
    label: "Three.js mesh/group/buffer geometry construction",
    pattern: /new THREE\.(Mesh|Group|BufferGeometry|BoxGeometry|ExtrudeGeometry|ShapeGeometry|CylinderGeometry|SphereGeometry|ConeGeometry|PlaneGeometry|LatheGeometry)\b/,
  },
  {
    key: "fake_brep_tag",
    label: "BRep tag on runtime object/userData",
    pattern: /(userData\.kind\s*=\s*["']brep["']|kind:\s*["']brep["'])/,
  },
  {
    key: "viewer_addmesh_brep",
    label: "viewer.addMesh(..., \"brep\") calls",
    pattern: /viewer\.addMesh\([^;\n]*["']brep["']/,
  },
  {
    key: "nurbs_sidecar_userdata",
    label: "NURBS sidecar stored on userData",
    pattern: /userData\.nurbsSurface/,
  },
  {
    key: "buffer_geometry_serialization",
    label: "BufferGeometry scene serialization/deserialization",
    pattern: /(exportScene\(|importScene\(|SerializedSceneObj|BufferGeometry\(\))/,
  },
  {
    key: "mesh_export_path",
    label: "Export path traverses Three.js objects/meshes",
    pattern: /(exportObj\(|exportStl\(|export3dm\(|object\.traverse\(|mesh\.isMesh)/,
  },
  {
    key: "canonical_nurbs_foothold",
    label: "Existing canonical NURBS/BRep foothold",
    pattern: /(Brep|Nurbs|nurbs|emitNurbsAdvancedBrep|IfcAdvancedBrep|brep[A-Z])/,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      out.push(...walk(abs));
    } else if (name.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

function scan(): Record<string, Finding[]> {
  const results: Record<string, Finding[]> = Object.fromEntries(PATTERNS.map((p) => [p.key, []]));
  const files = walk(SRC_ROOT);
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const spec of PATTERNS) {
        spec.pattern.lastIndex = 0;
        if (spec.pattern.test(line)) {
          results[spec.key].push({ file: rel, line: i + 1, text: line.trim().slice(0, 180) });
        }
      }
    }
  }
  return results;
}

function printReport(results: Record<string, Finding[]>): void {
  console.log("# BRep/NURBS Canonical Readiness Audit");
  console.log("");
  console.log(`Scanned: ${relative(ROOT, SRC_ROOT).replace(/\\/g, "/")}`);
  console.log("");
  for (const spec of PATTERNS) {
    const findings = results[spec.key];
    console.log(`## ${spec.label}`);
    console.log("");
    console.log(`Count: ${findings.length}`);
    console.log("");
    for (const hit of findings.slice(0, 20)) {
      console.log(`- ${hit.file}:${hit.line} - ${hit.text}`);
    }
    if (findings.length > 20) console.log(`- ... ${findings.length - 20} more`);
    console.log("");
  }
  console.log("This audit is informational. Counts identify migration surfaces; they are not pass/fail gates yet.");
}

printReport(scan());
