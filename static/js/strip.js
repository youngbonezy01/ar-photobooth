const STRIP_TEMPLATES = {
  cream: { bg: "#FBF6EF", frame: "#FFFFFF", border: "#E4D4BE", text: "#3A2E22", accent: "#C9A227" },
  pink:  { bg: "#F7DCE6", frame: "#FFFFFF", border: "#E9B9CE", text: "#5E1B34", accent: "#B8547C" },
  red:   { bg: "#5E1414", frame: "#711818", border: "#8C2A2A", text: "#F7E9E9", accent: "#E7B4B4" },
  black: { bg: "#0D0D0D", frame: "#1A1A1A", border: "#333333", text: "#F5F5F5", accent: "#D4AF37" },

};

let activeTemplate = "cream";

/* -------- review screen thumbnails (no stickers here anymore) -------- */
function renderShotThumbnails() {
  const wrap = document.getElementById("shots-strip");
  wrap.innerHTML = "";

  capturedShots.forEach((dataUrl, i) => {
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
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
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

async function renderStrip(templateId) {
  activeTemplate = templateId;
  const theme = STRIP_TEMPLATES[templateId];
  const canvas = document.getElementById("strip-canvas");
  const ctx = canvas.getContext("2d");

  const n = capturedShots.length;
  const W = 600;
  const margin = 26;
  const gap = 16;
  const slotW = W - margin * 2;
  const slotH = Math.round(slotW * 0.75);
  const footerH = 130;
  const H = margin + n * slotH + (n - 1) * gap + footerH + margin;

  canvas.width = W;
  canvas.height = H;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  const images = await Promise.all(capturedShots.map(loadImage));

  images.forEach((img, i) => {
    const x = margin;
    const y = margin + i * (slotH + gap);
    const { sx, sy, sw, sh } = coverRect(img, slotW, slotH);

    ctx.save();
    roundedRectPath(ctx, x, y, slotW, slotH, 10);
    ctx.clip();
    ctx.fillStyle = theme.frame;
    ctx.fillRect(x, y, slotW, slotH);
    ctx.drawImage(img, sx, sy, sw, sh, x, y, slotW, slotH);
    ctx.restore();

    ctx.save();
    roundedRectPath(ctx, x, y, slotW, slotH, 10);
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.border;
    ctx.stroke();
    ctx.restore();
  });

  // footer band
  const footerY = margin + n * slotH + (n - 1) * gap;
  ctx.save();
  ctx.fillStyle = theme.accent;
  ctx.globalAlpha = 0.14;
  ctx.fillRect(margin, footerY + 14, slotW, 2);
  ctx.restore();

  await document.fonts.ready;
  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.font = "italic 600 30px 'Cormorant Garamond', serif";
  ctx.fillText("shutter & strip", W / 2, footerY + 62);

  const dateStr = new Date().toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
  ctx.font = "600 13px 'Nunito', sans-serif";
  ctx.globalAlpha = 0.75;
  ctx.fillText(dateStr, W / 2, footerY + 90);
  ctx.globalAlpha = 1;

  // stickers go last so they sit on top of everything, anywhere on the strip
  ctx.save();
  ctx.font = "40px 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  placedStickers.forEach((st) => {
    ctx.fillText(st.glyph, st.xPct * W, st.yPct * H);
  });
  ctx.restore();
}

function setActiveTemplateSwatch(templateId) {
  document.querySelectorAll(".template-swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.template === templateId);
  });
}