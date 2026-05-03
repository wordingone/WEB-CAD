// Snap / constrain state singleton.
// Driven by the snap-dock widget in workbench.ts; consumed by create-mode.ts.

export interface SnapState {
  gridOn: boolean;
  step: number;  // grid step in meters
}

const _state: SnapState = { gridOn: true, step: 0.10 };

export function getGridOn(): boolean { return _state.gridOn; }
export function setGridOn(on: boolean): void { _state.gridOn = on; }
export function getStep(): number { return _state.step; }
export function setStep(m: number): void { _state.step = Math.max(0.001, m); }

// Quantise a world-space XY point.
// When grid is on: rounds to nearest step increment.
// When grid is off: still rounds to 1mm to avoid floating-point noise.
export function snapPoint(x: number, y: number): { x: number; y: number } {
  if (_state.gridOn) {
    const s = _state.step;
    return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
  }
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}
