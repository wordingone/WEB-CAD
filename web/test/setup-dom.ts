// Bun test preload — register happy-dom globals (window/document/DOMParser/etc).
// Wired via bunfig.toml [test] preload list.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// happy-dom doesn't compute layout, so getBoundingClientRect() returns 0×0
// by default. For tests that read sheet dimensions, fall back to inline
// style.width/height (which the layout controller sets explicitly in px).
// This is a test-environment polyfill only — runtime browsers have a real
// layout engine.
const origGetRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  const r = origGetRect.call(this) as DOMRect;
  if (r.width === 0 && r.height === 0 && this.style) {
    const w = parseFloat(this.style.width)  || 0;
    const h = parseFloat(this.style.height) || 0;
    if (w > 0 || h > 0) {
      return new DOMRect(0, 0, w, h);
    }
  }
  return r;
};
