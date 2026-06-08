/**
 * vault-prebake.mjs — bake vault query results into static assets for GitHub Pages.
 *
 * Runs vault-query.py for each building, writes:
 *   web/public/vault/precedent/<building>.json   — full query records (metadata only)
 *   web/public/vault/text/<qid>.txt              — L2 prose text (Wikipedia)
 *
 * Run once before committing; committed outputs are served as static assets.
 *
 * REGEN: re-run this script after any vault corpus update (new buildings, QID-cache
 * resolution, facet/layer changes). vault/manifest.json is a SNAPSHOT — it will silently
 * go stale if the underlying vault data changes without a re-run. Tracked: #52 (#619).
 *
 * Usage: node scripts/vault-prebake.mjs
 *        bun scripts/vault-prebake.mjs
 */

import { execSync } from "child_process";
import { copyFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const VAULT_ROOT = "B:/M/vault";
const OUT_PRECEDENT = join(ROOT, "web/public/vault/precedent");
const OUT_TEXT = join(ROOT, "web/public/vault/text");

for (const dir of [OUT_PRECEDENT, OUT_TEXT]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const BUILDINGS = ["villa-savoye", "white-house-washington-d-c"];

for (const building of BUILDINGS) {
  console.log(`[vault-prebake] querying ${building}...`);
  const raw = execSync(
    `python ${VAULT_ROOT}/scripts/vault-query.py --mode precedent --building ${building}`,
    { encoding: "utf8" }
  );
  const result = JSON.parse(raw);

  writeFileSync(join(OUT_PRECEDENT, `${building}.json`), JSON.stringify(result, null, 2));
  console.log(`  → web/public/vault/precedent/${building}.json (${result.count} records)`);

  for (const r of result.records) {
    if (r.layer === "L2" && r.datatype === "prose-description" && r.asset.local_path) {
      const qid = r.qid;
      const src = join(VAULT_ROOT, r.asset.local_path);
      const dst = join(OUT_TEXT, `${qid}.txt`);
      if (existsSync(src)) {
        copyFileSync(src, dst);
        console.log(`  → web/public/vault/text/${qid}.txt`);
      } else {
        console.warn(`  ! source missing: ${src}`);
      }
    }
  }
}

console.log("[vault-prebake] done");
