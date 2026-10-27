function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(`screen-${id}`).classList.add("active");
}

/* -------- shot count stepper -------- */
const MIN_SHOTS = 3;
const MAX_SHOTS = 6;

function updateStepperUI() {
  document.getElementById("shot-count").textContent = totalShots;
  document.getElementById("shot-minus").disabled = totalShots <= MIN_SHOTS;
  document.getElementById("shot-plus").disabled = totalShots >= MAX_SHOTS;
}

document.getElementById("shot-minus").addEventListener("click", () => {
  totalShots = Math.max(MIN_SHOTS, totalShots - 1);
  updateStepperUI();
});
document.getElementById("shot-plus").addEventListener("click", () => {
  totalShots = Math.min(MAX_SHOTS, totalShots + 1);
  updateStepperUI();
});

document.querySelectorAll(".timer-chip").forEach((el) => {
  el.addEventListener("click", () => {
    selectedTimerSeconds = parseInt(el.dataset.timer, 10);
    document.querySelectorAll(".timer-chip").forEach((c) => c.classList.remove("active"));
    el.classList.add("active");
  });
});

/* -------- start -> capture -------- */
document.getElementById("btn-start-capture").addEventListener("click", async () => {
  const ok = await startCamera();
  if (!ok) return;
  buildAperture();
  showScreen("capture");
  await runShotSequence();
  showScreen("review");
  renderShotThumbnails();
});

document.getElementById("btn-cancel-capture").addEventListener("click", () => {
  stopCamera();
  showScreen("start");
  startPreviewCamera(); // 👈 ADDED: Restart the preview when going back to start
});

/* -------- retake a single shot -------- */
async function retakeSingleShot(index) {
  showScreen("capture");
  document.getElementById("current-shot").textContent = index + 1;
  document.getElementById("total-shots").textContent = totalShots;
  document.getElementById("shot-progress").innerHTML = "";
  applyLiveFilter();
  const shot = await runCountdownAndCapture();
  capturedShots[index] = shot;
  showScreen("review");
  renderShotThumbnails();
}

/* -------- review screen -------- */
document.getElementById("btn-retake-all").addEventListener("click", () => {
  stopCamera();
  capturedShots = [];
  clearAllStickers();
  showScreen("start");
  startPreviewCamera(); // 👈 ADDED: Restart the preview when going back to start
});

document.querySelectorAll(".template-swatch").forEach((el) => {
  el.addEventListener("click", () => {
    setActiveTemplateSwatch(el.dataset.template);
    activeTemplate = el.dataset.template;
    renderStrip(activeTemplate); // live-update if we're already looking at the export preview
  });
});

document.getElementById("btn-to-export").addEventListener("click", async () => {
  showScreen("export");
  await renderStrip(activeTemplate);
  renderPlacedStickerList();
  stopCamera();
});

/* -------- export screen: tap the strip to place the selected sticker -------- */
document.getElementById("strip-click-overlay").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const xPct = (e.clientX - rect.left) / rect.width;
  const yPct = (e.clientY - rect.top) / rect.height;
  placeSticker(xPct, yPct);
  renderPlacedStickerList();
  renderStrip(activeTemplate);
});

document.getElementById("btn-download-pdf").addEventListener("click", downloadStripAsPdf);
document.getElementById("btn-print").addEventListener("click", printStrip);
document.getElementById("btn-start-over").addEventListener("click", () => {
  capturedShots = [];
  clearAllStickers();
  showScreen("start");
  startPreviewCamera(); // 👈 ADDED: Restart the preview when going back to start
});

/* -------- init -------- */
buildFilterGrid();
buildStickerPicker();
updateStepperUI();
setActiveTemplateSwatch(activeTemplate);
showScreen("start");