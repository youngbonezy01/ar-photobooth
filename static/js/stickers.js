// Each sticker is just an emoji glyph — easy to extend, no image assets needed.
// If you add stickers here, add their ids to STICKER_IDS in app.py too.
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

// Placed stickers live in state.stickers: [{ uid, id, glyph, xPct, yPct }]
// (positions relative to the WHOLE strip canvas).
// Solo: they only exist on this device. In a booth, the server keeps the list
// and everyone's copy is replaced whenever it changes (see room.js).

let localStickerCount = 0;

function stickerGlyph(id) {
  const s = STICKERS.find((x) => x.id === id);
  return s ? s.glyph : "";
}

// True when we're in a booth with a live connection: stickers go through the server.
function sharedStickersOn() {
  return (
    document.body.classList.contains("in-booth") &&
    typeof room !== "undefined" &&
    !!room.code &&
    !!room.socket &&
    room.socket.connected
  );
}

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
      const wasActive = state.activeStickerId === s.id;
      state.activeStickerId = wasActive ? null : s.id;
      document.querySelectorAll(".sticker-chip").forEach((c) => c.classList.remove("active"));
      if (!wasActive) btn.classList.add("active");
    });
    wrap.appendChild(btn);
  });
}

// Call with a click position expressed as a 0–1 fraction of the strip canvas.
function placeSticker(xPct, yPct) {
  if (!state.activeStickerId) return;
  const sticker = STICKERS.find((s) => s.id === state.activeStickerId);
  if (!sticker) return;

  if (sharedStickersOn()) {
    // The server adds it and sends the new list to everyone, including us
    room.socket.emit("add_sticker", { id: sticker.id, xPct, yPct });
    return;
  }
  state.stickers.push({
    uid: "L" + (++localStickerCount),
    id: sticker.id,
    glyph: sticker.glyph,
    xPct,
    yPct,
  });
}

function removeStickerByUid(uid) {
  if (sharedStickersOn()) {
    room.socket.emit("remove_sticker", { uid });
    return;
  }
  state.stickers = state.stickers.filter((s) => s.uid !== uid);
}

function clearAllStickers() {
  state.stickers = [];
}

// Small removable tag list shown under the strip preview so users can
// undo a specific sticker without needing to click a tiny emoji precisely.
function renderPlacedStickerList() {
  const wrap = document.getElementById("placed-stickers-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  state.stickers.forEach((st) => {
    const tag = document.createElement("button");
    tag.type = "button";
    tag.className = "placed-sticker-tag";
    tag.textContent = st.glyph;
    tag.title = "Remove this sticker";
    tag.addEventListener("click", () => {
      removeStickerByUid(st.uid);
      if (!sharedStickersOn()) {
        // solo: update right away. In a booth the server's update redraws it.
        renderPlacedStickerList();
        renderStrip(state.template);
      }
    });
    wrap.appendChild(tag);
  });
}