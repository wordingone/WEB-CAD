# Troubleshooting — WEB-CAD

## AI agent is slow or not responding

**Cause:** The Gemma 4 model (~1 GB) is still downloading on first visit, or WebGPU is not available.

**Fix:**
- Wait for the status bar to show "ready" (can take 30–60 s on first load).
- If WebGPU is unavailable, the model falls back to CPU inference — expect 10–30 s per response.
- Chrome 113+ / Edge 113+ are required for WebGPU. Firefox and Safari have limited support.
- Check DevTools Console for error messages starting with `[agent]`.

## IFC file won't load

**Cause:** Unsupported schema version, or corrupt file.

**Fix:**
- IFC2×3 and IFC4 are supported. IFC4x3 may work partially.
- Files over ~50 MB can be slow (parsed entirely in the browser).
- Check the status bar for the error message.
- Try opening the file in another viewer (BlenderBIM, BimVision) to confirm it's valid.

## STEP file parsing hangs

**Cause:** Large or complex STEP files can take tens of seconds in OpenCascade WASM.

**Fix:**
- Wait — parsing runs in a web worker and won't freeze the UI.
- Check the status bar; it shows "Parsing … via OpenCascade" while working.
- If it takes more than 2 minutes, reload the page and try a simpler file.

## Geometry looks wrong after import

**Cause:** Units or coordinate system mismatch between the source file and WEB-CAD.

**Fix:**
- WEB-CAD works in metres. STL and OBJ files often use millimetres — import may appear very small. Use the viewport's "fit to extents" (`F` key) to see the model.
- IFC files embed unit information; web-ifc applies it automatically.

## Export produces an empty file

**Cause:** No geometry loaded, or the format requires specific geometry type.

**Fix:**
- STEP export is only available when geometry was loaded from or produced by OpenCascade. For three.js-loaded geometry (GLB, OBJ), use GLB or OBJ export instead.
- Ensure at least one object is in the scene.

## Auto-save / session restore not working

**Cause:** IndexedDB blocked by browser privacy settings (private/incognito mode).

**Fix:**
- Use a normal (non-private) browser window.
- Some browsers block IndexedDB in third-party contexts — open the app in its own tab directly.

## The viewport is black / nothing renders

**Cause:** WebGL not available or GPU context lost.

**Fix:**
- Check `chrome://gpu` for WebGL status.
- Reload the page — a lost GPU context often recovers on reload.
- Try a different browser.

## "Loading OpenCascade WebAssembly…" never clears

**Cause:** WASM load failed (network error, CSP block, or browser incompatibility).

**Fix:**
- Check the browser Console (F12) for errors.
- Reload the page.
- Ensure the browser allows WebAssembly (may be blocked by some enterprise policies).

## Cold-cache reproduction (for bug reports)

To reproduce a cold-cache first-visit state:

1. Open DevTools → Application → Storage → Clear site data.
2. Hard-reload: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac).
3. The page now behaves as on a first visit — model download, WASM load, no IndexedDB.

Include the browser + OS + the exact steps in your bug report.
