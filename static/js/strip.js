const STRIP_TEMPLATES = {
  cream: { bg: "#FBF6EF", frame: "#FFFFFF", border: "#E4D4BE", text: "#3A2E22", accent: "#C9A227" },
  pink:  { bg: "#F7DCE6", frame: "#FFFFFF", border: "#E9B9CE", text: "#5E1B34", accent: "#B8547C" },
  red:   { bg: "#5E1414", frame: "#711818", border: "#8C2A2A", text: "#F7E9E9", accent: "#E7B4B4" },
  black: { bg: "#0D0D0D", frame: "#1A1A1A", border: "#333333", text: "#F5F5F5", accent: "#D4AF37" },
};

// Each call to renderStrip() takes a ticket. If a newer call starts while an
// older one is still waiting on images/fonts, the older one quietly stops, so
// two renders can never draw over each other on the same canvas.
let renderTicket = 0;

// Decoded images, keyed by their dataURL, so re-rendering (e.g. after placing a
// sticker) doesn't have to decode every photo again.
const imageCache = new Map();

/* -------- review screen thumbnails (no stickers here anymore) -------- */
function renderShotThumbnails() {
  const wrap = document.getElementById("shots-strip");
  wrap.innerHTML = "";

  me().shots.forEach((dataUrl, i) => {
    const thumb = document.createElement("div");
    thumb.className = "shot-thumb";

    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = `Shot ${i + 1}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Retake";
    btn.addEventListener("click", () => retakeSingleShot(i));

    thumb.appendChild(img);
    thumb.appendChild(btn);
    wrap.appendChild(thumb);
  });
}

function loadImage(src) {
  if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

// Drop cached images for photos that are no longer in use (retakes).
function pruneImageCache() {
  const inUse = new Set();
  state.participants.forEach((p) => p.shots.forEach((s) => s && inUse.add(s)));
  for (const key of imageCache.keys()) {
    if (!inUse.has(key)) imageCache.delete(key);
  }
}

function coverRect(img, targetW, targetH) {
  const srcRatio = img.width / img.height;
  const targetRatio = targetW / targetH;
  let sx, sy, sw, sh;
  if (srcRatio > targetRatio) {
    sh = img.height;
    sw = sh * targetRatio;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / targetRatio;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  return { sx, sy, sw, sh };
}

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Works out every size on the sheet: one column per person, one row per shot.
// Solo keeps the original 600px-wide strip; groups use a fixed column width.
function stripLayout(cols, rows) {
  const solo = cols === 1;
  const margin = 26;
  const gap = 16;
  const slotW = solo ? 548 : 340;
  const slotH = Math.round(slotW * 0.75);
  const nameBlock = solo ? 0 : 40;   // row for the names under each column
  const footerH = 130;
  const gridH = rows * slotH + (rows - 1) * gap;
  const W = margin * 2 + cols * slotW + (cols - 1) * gap;
  const H = margin + gridH + nameBlock + footerH + margin;
  return { solo, margin, gap, slotW, slotH, nameBlock, footerH, gridH, W, H };
}

// Shows the canvas at a sensible size on screen. Solo keeps the 320px cap from
// main.css; groups get a wider preview. (Takes effect each time the strip renders.)
function applyStripDisplaySize(canvas, cols) {
  const exportWrap = document.querySelector(".export-wrap");
  if (cols === 1) {
    canvas.style.width = "";
    canvas.style.maxWidth = "";
    if (exportWrap) exportWrap.style.maxWidth = "";
  } else {
    const target = Math.min(1000, window.innerWidth - 40);
    canvas.style.maxWidth = "none";
    canvas.style.width = target + "px";
    if (exportWrap) exportWrap.style.maxWidth = "1100px";
  }
}

async function renderStrip(templateId) {
  state.template = templateId;

  const people = state.participants;
  const cols = people.length;
  const rows = Math.max(0, ...people.map((p) => p.shots.length));
  if (cols === 0 || rows === 0) return; // nothing to draw yet

  const myTicket = ++renderTicket;
  pruneImageCache();

  const theme = STRIP_TEMPLATES[templateId];
  const canvas = document.getElementById("strip-canvas");
  const ctx = canvas.getContext("2d");
  const L = stripLayout(cols, rows);

  // Load every photo on the sheet before touching the canvas.
  const allShots = [];
  people.forEach((p) => p.shots.forEach((s) => s && allShots.push(s)));
  await Promise.all([...new Set(allShots)].map(loadImage));
  if (myTicket !== renderTicket) return; // a newer render took over

  canvas.width = L.W;
  canvas.height = L.H;
  applyStripDisplaySize(canvas, cols);

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, L.W, L.H);

  // photo grid: column = person, row = shot number
  people.forEach((person, c) => {
    for (let r = 0; r < rows; r++) {
      const x = L.margin + c * (L.slotW + L.gap);
      const y = L.margin + r * (L.slotH + L.gap);
      const src = person.shots[r];
      const img = src ? imageCache.get(src) : null;

      ctx.save();
      roundedRectPath(ctx, x, y, L.slotW, L.slotH, 10);
      ctx.clip();
      ctx.fillStyle = theme.frame;
      ctx.globalAlpha = img ? 1 : 0.35;   // empty frame if this person has no photo yet
      ctx.fillRect(x, y, L.slotW, L.slotH);
      ctx.globalAlpha = 1;
      if (img) {
        const { sx, sy, sw, sh } = coverRect(img, L.slotW, L.slotH);
        ctx.drawImage(img, sx, sy, sw, sh, x, y, L.slotW, L.slotH);
      }
      ctx.restore();

      ctx.save();
      roundedRectPath(ctx, x, y, L.slotW, L.slotH, 10);
      ctx.lineWidth = 2;
      ctx.strokeStyle = theme.border;
      ctx.stroke();
      ctx.restore();
    }
  });

  const footerY = L.margin + L.gridH;

  await document.fonts.ready;
  if (myTicket !== renderTicket) return; // a newer render took over

  // names under each column (groups only)
  if (!L.solo) {
    ctx.save();
    ctx.fillStyle = theme.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 17px 'Nunito', sans-serif";
    people.forEach((person, c) => {
      const cx = L.margin + c * (L.slotW + L.gap) + L.slotW / 2;
      ctx.fillText(String(person.name || "").slice(0, 14), cx, footerY + 26);
    });
    ctx.restore();
  }

  // footer band
  const bandY = footerY + L.nameBlock;
  ctx.save();
  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(L.margin, bandY + 14, L.W - L.margin * 2, 2);
  ctx.restore();

  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "italic 600 30px 'Cormorant Garamond', serif";
  ctx.fillText("shutter & strip", L.W / 2, bandY + 62);

  const dateStr = new Date().toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
  ctx.font = "600 13px 'Nunito', sans-serif";
  ctx.globalAlpha = 0.75;
  ctx.fillText(dateStr, L.W / 2, bandY + 90);
  ctx.globalAlpha = 1;

  // stickers go last so they sit on top of everything, anywhere on the sheet
  ctx.save();
  ctx.font = "40px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  state.stickers.forEach((st) => {
    ctx.fillText(st.glyph, st.xPct * L.W, st.yPct * L.H);
  });
  ctx.restore();
}

function setActiveTemplateSwatch(templateId) {
  document.querySelectorAll(".template-swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.template === templateId);
  });
}

/* ==========================================================
   DEV TOOL — delete this block once real rooms work.
   In the browser console, type:  fakeBooth(6)
   It fills the booth with n fake people and jumps to the export screen.
   Reset with:  resetSession()  then refresh the page.
   ========================================================== */
const FAKE_NAMES = ["You", "Mika", "Jon", "Bea", "Kai", "Lia"];

function makePlaceholderShot(personIdx, shotIdx, name) {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 480;
  const g = c.getContext("2d");
  const hue = (personIdx * 55 + shotIdx * 12) % 360;
  const grad = g.createLinearGradient(0, 0, 640, 480);
  grad.addColorStop(0, `hsl(${hue}, 70%, 70%)`);
  grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 70%, 45%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 640, 480);
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "700 64px sans-serif";
  g.fillText(name, 320, 210);
  g.font = "600 42px sans-serif";
  g.fillText(`shot ${shotIdx + 1}`, 320, 290);
  return c.toDataURL("image/jpeg", 0.8);
}

async function fakeBooth(n = 4) {
  n = Math.max(1, Math.min(MAX_PEOPLE, n));
  const realShots = me().shots.filter(Boolean);
  const rows = realShots.length || state.totalShots;

  state.participants = [];
  for (let p = 0; p < n; p++) {
    const id = p === 0 ? "me" : "fake" + p;
    const name = FAKE_NAMES[p];
    const shots = [];
    for (let r = 0; r < rows; r++) {
      // if you already took real photos, your own column uses them
      shots.push(p === 0 && realShots.length ? realShots[r] : makePlaceholderShot(p, r, name));
    }
    state.participants.push({ id, name, shots });
  }
  state.myId = "me";

  showScreen("export");
  await renderStrip(state.template);
  renderPlacedStickerList();
}