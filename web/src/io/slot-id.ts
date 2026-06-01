// Slot isolation: when WEB-CAD is opened with ?slot=<id>, each IDB database
// is namespaced by the slot ID so concurrent slot tabs never share persisted state.
// Empty string when no slot param — default (non-slot) sessions are unaffected.
export const SLOT_SUFFIX: string =
  typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('slot') ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
    : '';
