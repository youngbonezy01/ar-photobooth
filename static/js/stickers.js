// Each sticker is just an emoji glyph — easy to extend, no image assets needed.
const STICKERS = [
  { id: "heart",   glyph: "💗" },
  { id: "sparkle", glyph: "✨" },
  { id: "star",    glyph: "⭐" },
  { id: "flower",  glyph: "🌸" },
  { id: "bow",     glyph: "🎀" },
  { id: "cherry",  glyph: "🍒" },
  { id: "cloud",   glyph: "☁️" },
  { id: "cake",    glyph: "🍰" },
];

let activeStickerId = null;      // currently selected sticker to place
let placedStickers = [];         // [{glyph, xPct, yPct}] — positions relative to the WHOLE strip canvas

function buildStickerPicker() {
  const wrap = document.getElementById("sticker-grid");
  wrap.innerHTML = "";

  STICKERS.forEach((s) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sticker-chip";
    btn.textContent = s.glyph;
    btn.dataset.stickerId = s.id;
    btn.addEventListener("click", () => {
      const wasActive = activeStickerId === s.id;
      activeStickerId = wasActive ? null : s.id;
      document.querySelectorAll(".sticker-chip").forEach((c) => c.classList.remove("active"));
      if (!wasActive) btn.classList.add("active");
    });
    wrap.appendChild(btn);
  });
}

// Call with a click position expressed as a 0–1 fraction of the strip canvas.
function placeSticker(xPct, yPct) {
  if (!activeStickerId) return;
  const sticker = STICKERS.find((s) => s.id === activeStickerId);
  placedStickers.push({ glyph: sticker.glyph, xPct, yPct });
}

function removeStickerAt(index) {
  placedStickers.splice(index, 1);
}

function clearAllStickers() {
  placedStickers = [];
}

// Small removable tag list shown under the strip preview so users can
// undo a specific sticker without needing to click a tiny emoji precisely.
function renderPlacedStickerList() {
  const wrap = document.getElementById("placed-stickers-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  placedStickers.forEach((st, idx) => {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "placed-sticker-tag";
    tag.textContent = st.glyph;
    tag.title = "Remove this sticker";
    tag.addEventListener("click", () => {
      removeStickerAt(idx);
      renderPlacedStickerList();
      renderStrip(activeTemplate);
    });
    wrap.appendChild(tag);
  });
}