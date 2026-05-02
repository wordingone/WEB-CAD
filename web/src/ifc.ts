// IFC4 STEP-21 emit + round-trip verification via web-ifc.
//
// buildIfc + IfcMesh re-exported from ifc-build.ts (pure-build half, no
// browser-only imports). ifcRoundTrip below is browser-only because it
// pulls in web-ifc's WASM via Vite's `?url` asset import.

import * as WebIFC from "web-ifc";
// @ts-ignore
import webIfcWasmUrl from "web-ifc/web-ifc.wasm?url";

export { buildIfc, type IfcMesh } from "./ifc-build.js";

// --- Round-trip verification via web-ifc -------------------------------------

let _ifcApi: WebIFC.IfcAPI | null = null;
export async function getIfcApi(): Promise<WebIFC.IfcAPI> {
  if (_ifcApi) return _ifcApi;
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath("", true);
  // Force single-thread (forceSingleThread=true). Even with COOP+COEP set,
  // the multithreaded build (web-ifc-mt.wasm) tries to import a worker that
  // Vite dev's transform layer doesn't ship; the single-thread build is
  // sufficient for OpenModel + GetModelSchema + GetLineIDsWithType which
  // is all we need for round-trip verification. locateFile redirects every
  // .wasm request to the same single-threaded asset URL emitted by Vite.
  await api.Init((path: string) => {
    if (path.endsWith(".wasm")) return webIfcWasmUrl;
    return path;
  }, true);
  _ifcApi = api;
  return api;
}

export type RoundTripResult = {
  ok: boolean;
  schema: string | null;
  productCount: number;
  byteSize: number;
  error?: string;
};

export async function ifcRoundTrip(bytes: Uint8Array): Promise<RoundTripResult> {
  try {
    const api = await getIfcApi();
    const modelID = api.OpenModel(bytes, {});
    if (modelID < 0) {
      return { ok: false, schema: null, productCount: 0, byteSize: bytes.byteLength, error: "OpenModel returned -1" };
    }
    const schema = api.GetModelSchema(modelID);
    // Count IfcBuildingElementProxy entities — confirms the geometry round-tripped.
    const proxies = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGELEMENTPROXY);
    const productCount = proxies.size();
    api.CloseModel(modelID);
    return { ok: true, schema, productCount, byteSize: bytes.byteLength };
  } catch (e) {
    return {
      ok: false,
      schema: null,
      productCount: 0,
      byteSize: bytes.byteLength,
      error: (e as Error).message,
    };
  }
}
