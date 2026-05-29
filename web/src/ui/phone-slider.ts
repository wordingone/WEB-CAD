export type SliderTab = "ARCH" | "CAD";

export interface PhoneSliderOpts {
  initial?: SliderTab;
  onChange: (tab: SliderTab) => void;
}

// Disc rotates → squares orbit around the center.
// Each square counter-rotates by the same amount so it stays axis-aligned (no spin).
// Labels inside the squares need no rotation of their own.
export function buildPhoneSlider(opts: PhoneSliderOpts): { root: HTMLElement; setTab: (t: SliderTab) => void } {
  let active: SliderTab = opts.initial ?? "ARCH";
  let totalRot = active === "CAD" ? 180 : 0;

  const root = document.createElement("div");
  root.className = "yin-toggle";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Switch ARCH/CAD palette section");
  root.setAttribute("tabindex", "0");

  const disc = document.createElement("div");
  disc.className = "yin-disc";
  root.appendChild(disc);

  function makeHalf(cls: string, tab: SliderTab) {
    const half = document.createElement("div");
    half.className = `yin-half ${cls}`;
    half.dataset.tab = tab;
    half.setAttribute("role", "button");
    half.setAttribute("aria-label", `Show ${tab} model tools`);
    half.setAttribute("aria-pressed", active === tab ? "true" : "false");
    const span = document.createElement("span");
    span.className = "yin-label";
    span.textContent = tab;
    half.appendChild(span);
    disc.appendChild(half);
    return half;
  }

  const archHalf = makeHalf("yin-half--top", "ARCH");
  const compHalf = makeHalf("yin-half--btm", "CAD");

  disc.addEventListener("transitionend", (e) => {
    if ((e as TransitionEvent).propertyName === "transform" && e.target === disc) {
      disc.classList.toggle("is-comp", active === "CAD");
    }
  });

  function syncSemanticState() {
    root.dataset.activeTab = active;
    root.setAttribute("aria-label", `Switch ARCH/CAD palette section, ${active} active`);
    archHalf.setAttribute("aria-pressed", active === "ARCH" ? "true" : "false");
    compHalf.setAttribute("aria-pressed", active === "CAD" ? "true" : "false");
    disc.classList.toggle("is-comp", active === "CAD");
  }

  function applyRotation(skipTransition = false) {
    if (skipTransition) {
      disc.style.transition = "none";
      archHalf.style.transition = "none";
      compHalf.style.transition = "none";
      void disc.offsetWidth;
    }
    disc.style.transform = `rotate(${totalRot}deg)`;
    // Counter-rotate each square so it stays upright while orbiting
    archHalf.style.transform = `rotate(${-totalRot}deg)`;
    compHalf.style.transform = `rotate(${-totalRot}deg)`;
    if (skipTransition) {
      disc.style.transition = "";
      archHalf.style.transition = "";
      compHalf.style.transition = "";
    }
  }

  function setActive(tab: SliderTab, skipTransition = false) {
    if (active === tab) return;
    active = tab;
    totalRot = tab === "CAD" ? 180 : 0;
    syncSemanticState();
    applyRotation(skipTransition);
    opts.onChange(active);
  }

  function toggle() {
    setActive(active === "ARCH" ? "CAD" : "ARCH");
  }

  archHalf.addEventListener("click", (e) => {
    e.stopPropagation();
    setActive("ARCH");
  });
  compHalf.addEventListener("click", (e) => {
    e.stopPropagation();
    setActive("CAD");
  });

  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".yin-half")) return;
    toggle();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); }
  });

  syncSemanticState();
  applyRotation(true);

  function setTab(t: SliderTab) {
    setActive(t);
  }

  return { root, setTab };
}
