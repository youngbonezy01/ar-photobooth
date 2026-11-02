function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(`screen-${id}`).classList.add("active");
}

/* -------- shot count stepper -------- */
const MIN_SHOTS = 3;
const MAX_SHOTS = 6;

function updateStepperUI() {
  document.getElementById("shot-count").textContent = state.totalShots;
  document.getElementById("shot-minus").disabled = state.totalShots <= MIN_SHOTS;
  document.getElementById("shot-plus").disabled = state.totalShots >= MAX_SHOTS;
}

document.getElementById("shot-minus").addEventListener("click", () => {
  state.totalShots = Math.max(MIN_SHOTS, state.totalShots - 1);
  updateStepperUI();
});
document.getElementById("shot-plus").addEventListener("click", () => {
  state.totalShots = Math.min(MAX_SHOTS, state.totalShots + 1);
  updateStepperUI();
});

document.querySelectorAll(".timer-chip").forEach((el) => {
  el.addEventListener("click", () => {
    state.timerSeconds = parseInt(el.dataset.timer, 10);
    document.querySelectorAll(".timer-chip").forEach((c) => c.classList.remove("active"));
    el.classList.add("active");
  });
});

/* -------- start -> capture -> review -------- */

// Opens the camera and shows the capture screen. Booths call this on its own
// (then wait for everyone), the solo Start button calls it via runCaptureFlow().
async function openCaptureScreen() {
  const ok = await startCamera();
  if (!ok) return false;
  buildAperture();
  showScreen("capture");
  return true;
}

async function runCaptureFlow() {
  const opened = await openCaptureScreen();
  if (!opened) return false;
  const finished = await runShotSequence();
  if (!finished) return true;          // cancelled: don't jump to review
  showScreen("review");
  renderShotThumbnails();
  return true;
}

document.getElementById("btn-start-capture").addEventListener("click", () => {
  runCaptureFlow();
});

document.getElementById("btn-cancel-capture").addEventListener("click", () => {
  cancelCapture();       // stops a countdown that is still running
  exitBoothIfAny();      // defined in room.js: leaves the booth if we're in one
  stopCamera();
  showScreen("start");
  startPreviewCamera(); // restart the preview when going back to start
});

/* -------- retake a single shot (solo only; booth photos are already shared) -------- */
async function retakeSingleShot(index) {
  if (document.body.classList.contains("in-booth")) return;
  showScreen("capture");
  document.getElementById("current-shot").textContent = index + 1;
  document.getElementById("total-shots").textContent = state.totalShots;
  document.getElementById("shot-progress").innerHTML = "";
  applyLiveFilter();
  const shot = await runCountdownAndCapture(startCaptureRun());
  if (shot === null) return;           // Cancel pressed meanwhile
  me().shots[index] = shot;
  showScreen("review");
  renderShotThumbnails();
}

/* -------- review screen -------- */
document.getElementById("btn-retake-all").addEventListener("click", () => {
  cancelCapture();
  exitBoothIfAny();
  stopCamera();
  resetSession();
  showScreen("start");
  startPreviewCamera(); // restart the preview when going back to start
});

document.querySelectorAll(".template-swatch").forEach((el) => {
  el.addEventListener("click", () => {
    setActiveTemplateSwatch(el.dataset.template);
    state.template = el.dataset.template;
    renderStrip(state.template); // live-update if we're already looking at the export preview
  });
});

document.getElementById("btn-to-export").addEventListener("click", async () => {
  showScreen("export");
  await renderStrip(state.template);
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
  renderStrip(state.template);
});

// NEW
document.getElementById("btn-download-image").addEventListener("click", downloadStripAsImage);
document.getElementById("btn-print").addEventListener("click", printStrip);
document.getElementById("btn-start-over").addEventListener("click", () => {
  exitBoothIfAny();
  resetSession();
  showScreen("start");
  startPreviewCamera(); // restart the preview when going back to start
});

/* -------- init -------- */
buildFilterGrid();
buildStickerPicker();
updateStepperUI();
setActiveTemplateSwatch(state.template);
showScreen("start");