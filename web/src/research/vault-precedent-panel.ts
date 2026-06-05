// vault-precedent-panel.ts — vault-spine-backed precedent panel for the research mode.
//
// Fetches pre-baked /vault/precedent/<building>.json (written by scripts/vault-prebake.mjs),
// and /vault/text/<qid>.txt for L2 prose. Renders:
//   - Building header (name, year, country, QID)
//   - Photo grid  (L1 photograph records, using asset.exact_url)
//   - L2 prose excerpt  (Wikipedia text, first 480 chars)
//
// Each record cites its vault QID/key so provenance is traceable back to the manifest.

export interface VaultRecord {
  layer: string;
  building: string | null;
  qid: string | null;
  facet: string | null;
  datatype: string;
  format: string;
  asset: {
    exact_url: string | null;
    local_path: string | null;
    content_hash: string | null;
    byte_verified: boolean;
    size_bytes: number | null;
  };
  context: {
    era: string | null;
    year: number | null;
    type: string | null;
    country: string | null;
  };
}

export interface VaultQueryResult {
  schema_version: number;
  query: { mode: string; filter: Record<string, string | null> };
  count: number;
  records: VaultRecord[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function buildingDisplayName(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function buildVaultPrecedentPanel(building = "white-house-washington-d-c"): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "vault-panel";

  // Header
  const header = document.createElement("div");
  header.className = "research-header vault-header";
  header.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="flex-shrink:0">
      <rect x="1" y="1" width="11" height="11" rx="1" stroke="currentColor" stroke-width="1.2"/>
      <path d="M3 5h7M3 7.5h5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
    </svg>
    VAULT · PRECEDENT
    <span class="pill" id="vault-pill">loading…</span>
  `;
  wrap.appendChild(header);

  const pill = header.querySelector<HTMLElement>("#vault-pill")!;

  // Body
  const body = document.createElement("div");
  body.className = "vault-body";
  wrap.appendChild(body);

  // ── Fetch records + prose ────────────────────────────────────────────────────

  const base = import.meta.env?.BASE_URL ?? "/WEB-CAD/";

  function vaultUrl(path: string): string {
    return `${base}vault/${path}`.replace(/\/+/g, "/").replace(":/", "://");
  }

  fetch(vaultUrl(`precedent/${building}.json`))
    .then((r) => r.json() as Promise<VaultQueryResult>)
    .then((data) => renderRecords(data))
    .catch((e) => {
      pill.textContent = "error";
      body.innerHTML = `<p class="vault-error">Failed to load vault data: ${esc(String(e))}</p>`;
    });

  function renderRecords(data: VaultQueryResult): void {
    const records = data.records;

    const photos = records.filter(
      (r) => r.layer === "L1" && r.datatype === "photograph" && r.asset.exact_url,
    );
    const proseRecord = records.find(
      (r) => r.layer === "L2" && r.datatype === "prose-description",
    );
    const qid = records[0]?.qid ?? null;
    const ctx = records[0]?.context ?? {};

    pill.textContent = `${records.length} records`;

    // ── Building header row
    const bldRow = document.createElement("div");
    bldRow.className = "vault-building-row";
    bldRow.innerHTML = `
      <span class="vault-bld-name">${esc(buildingDisplayName(building))}</span>
      <span class="vault-bld-meta">${ctx.year ?? "—"} · ${esc(ctx.country ?? "—")} · ${esc(ctx.type ?? "—")}</span>
      ${qid ? `<a class="vault-qid" href="https://www.wikidata.org/wiki/${escAttr(qid)}" target="_blank" rel="noopener">${esc(qid)}</a>` : ""}
    `;
    body.appendChild(bldRow);

    // ── Photo grid
    if (photos.length > 0) {
      const grid = document.createElement("div");
      grid.className = "vault-photos";
      for (const p of photos.slice(0, 3)) {
        const card = document.createElement("div");
        card.className = "vault-photo-card";
        const qidLabel = p.qid ? esc(p.qid) : "";
        const facetLabel = p.facet ? esc(p.facet) : "";
        card.innerHTML = `
          <img
            src="${escAttr(p.asset.exact_url!)}"
            alt="${esc(buildingDisplayName(building))} — ${facetLabel}"
            loading="lazy"
            class="vault-photo-img"
          />
          <div class="vault-photo-meta">${qidLabel}${p.asset.byte_verified ? ' <span class="vault-verified">✓</span>' : ""}</div>
        `;
        grid.appendChild(card);
      }
      body.appendChild(grid);
    }

    // ── L2 prose excerpt
    if (proseRecord) {
      const proseQid = proseRecord.qid;
      const proseDiv = document.createElement("div");
      proseDiv.className = "vault-prose";
      proseDiv.innerHTML = `<div class="vault-prose-loading">Loading prose…</div>`;
      body.appendChild(proseDiv);

      const textUrl = proseQid
        ? vaultUrl(`text/${proseQid}.txt`)
        : null;

      if (textUrl) {
        fetch(textUrl)
          .then((r) => r.text())
          .then((txt) => {
            const excerpt = txt.replace(/\s+/g, " ").trim().slice(0, 480);
            const source = proseRecord.asset.exact_url ?? "";
            proseDiv.innerHTML = `
              <div class="vault-prose-text">${esc(excerpt)}…</div>
              <div class="vault-prose-cite">
                L2 prose · ${proseQid ? `<a href="https://www.wikidata.org/wiki/${escAttr(proseQid)}" target="_blank" rel="noopener">${esc(proseQid)}</a>` : "—"}
                ${source ? ` · <a href="${escAttr(source)}" target="_blank" rel="noopener">source</a>` : ""}
              </div>
            `;
          })
          .catch(() => {
            proseDiv.innerHTML = `<div class="vault-prose-text vault-error">Prose unavailable offline.</div>`;
          });
      }
    }
  }

  return wrap;
}
