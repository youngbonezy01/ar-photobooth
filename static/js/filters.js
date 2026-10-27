// Filter presets. `css` is applied live to the <video> preview and baked
// into the captured canvas frame so what you see is what you get.
const FILTERS = [
  { id: "original",  label: "Original",     css: "none" },
  { id: "bw",        label: "B & W",        css: "grayscale(1) contrast(1.05)" },
  { id: "sepia",     label: "Vintage",      css: "sepia(0.55) contrast(1.05) saturate(1.1)" },
  { id: "warm",      label: "Warm Glow",    css: "saturate(1.25) brightness(1.05) hue-rotate(-6deg)" },
  { id: "cool",      label: "Cool Tone",    css: "saturate(1.1) brightness(1.02) hue-rotate(12deg)" },
  { id: "contrast",  label: "High Contrast",css: "contrast(1.35) saturate(1.15)" },
  { id: "soft",      label: "Soft Film",    css: "contrast(0.95) brightness(1.08) saturate(0.9) blur(0.3px)" },
  { id: "rosy",      label: "Rosy Pink",    css: "sepia(0.3) saturate(1.4) hue-rotate(-20deg) brightness(1.05)" },
  { id: "golden",    label: "Golden Hour",  css: "sepia(0.35) saturate(1.3) brightness(1.1) hue-rotate(-8deg)" },
  { id: "bluehour",  label: "Blue Hour",    css: "saturate(1.2) brightness(0.95) hue-rotate(190deg) contrast(1.05)" },
  { id: "noir",      label: "Noir",         css: "grayscale(1) contrast(1.4) brightness(0.92)" },
  { id: "faded",     label: "Faded",        css: "contrast(0.85) saturate(0.7) brightness(1.1) sepia(0.15)" },
  { id: "dreamy",    label: "Dreamy",       css: "brightness(1.12) saturate(1.15) contrast(0.9) blur(0.5px)" },
];

let activeFilterId = "original";

function getFilterById(id) {
  return FILTERS.find(f => f.id === id) || FILTERS[0];
}

function buildFilterGrid() {
  const grid = document.getElementById("filter-grid");
  grid.innerHTML = "";
  FILTERS.forEach((f, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip" + (f.id === activeFilterId ? " active" : "");
    chip.textContent = f.label;
    chip.dataset.filterId = f.id;
    chip.addEventListener("click", () => {
      activeFilterId = f.id;
      [...grid.children].forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
    });
    grid.appendChild(chip);
  });
}