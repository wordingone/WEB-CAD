// Singleton rhino3dm initializer.
// Imports the WASM URL so Vite includes rhino3dm.wasm as a hashed asset in the
// production build — without this the WASM is missing from deployed Pages.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite ?url import; typed via vite/client in tsconfig
import rhino3dmWasmUrl from "rhino3dm/rhino3dm.wasm?url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _rh: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getRhino3dm(): Promise<any> {
  if (_rh) return _rh;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const init = ((await import("rhino3dm")) as any).default;
  _rh = await init({
    locateFile: (f: string) => (f.endsWith(".wasm") ? (rhino3dmWasmUrl as string) : f),
  });
  return _rh;
}
