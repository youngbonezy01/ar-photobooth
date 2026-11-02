const SVG_NS = "http://www.w3.org/2000/svg";

const video = document.getElementById("camera-feed");
const previewVideo = document.getElementById("preview-video");
const captureCanvas = document.getElementById("capture-canvas");

let mediaStream = null;
let irisHole, flashRect;

// Every capture (a full set, or one retake) takes a run number. cancelCapture()
// bumps the number, so a countdown that is still running notices it has been
// replaced or cancelled and stops, instead of snapping a photo later.
let captureRunId = 0;
function startCaptureRun() { return ++captureRunId; }
function cancelCapture() { captureRunId++; }

// If Ambient Magic is switched ON (its state lives in ai-props.js), restart the
// scene detection on whichever video is now showing.
function resumeMagicProps(videoElement) {
  try {
    if (isMagicPropsEnabled) {
      currentMood = "";                 // force props to respawn on the next scan
      startSceneDetection(videoElement);
    }
  } catch (e) {
    // ai-props.js not ready yet, safe to ignore
  }
}

// 👇 Start the preview on page load
async function startPreviewCamera() {
  try {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
    }
    if (previewVideo) {
      previewVideo.srcObject = mediaStream;
      applyLiveFilter();

      const previewCanvas = document.getElementById("ar-overlay-preview");
      if (previewCanvas) startARLoop(previewVideo, previewCanvas);

      resumeMagicProps(previewVideo);
    }
    document.getElementById("camera-error").hidden = true;
  } catch (err) {
    document.getElementById("camera-error").hidden = false;
  }
}

// Call it immediately when the script loads
startPreviewCamera();

// 👇 Reuse the stream if we already have it from the preview
async function startCamera() {
  try {
    if (!mediaStream) {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
    }
    video.srcObject = mediaStream;
    applyLiveFilter();

    const captureCanvasAR = document.getElementById("ar-overlay-capture");
    if (captureCanvasAR) startARLoop(video, captureCanvasAR);

    resumeMagicProps(video);

    document.getElementById("camera-error").hidden = true;
    return true;
  } catch (err) {
    document.getElementById("camera-error").hidden = false;
    return false;
  }
}

function stopCamera() {
  // Stop the AR loop FIRST so it isn't left running on a dead stream
  stopARLoop();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  stopSceneDetection();
}

// 👇 Apply filter to BOTH the preview and the capture video
function applyLiveFilter() {
  const filterCss = getFilterById(state.filterId).css;
  if (video) video.style.filter = filterCss;
  if (previewVideo) previewVideo.style.filter = filterCss;
}

document.getElementById('filter-grid').addEventListener('click', () => {
  setTimeout(applyLiveFilter, 10);
});

/* -------- shot progress dots -------- */
function buildShotProgressDots() {
  const wrap = document.getElementById("shot-progress");
  wrap.innerHTML = "";
  for (let i = 0; i < state.totalShots; i++) {
    const d = document.createElement("span");
    d.className = "dot";
    wrap.appendChild(d);
  }
  updateShotProgressDots();
}

function updateShotProgressDots() {
  const dots = document.querySelectorAll("#shot-progress .dot");
  dots.forEach((d, i) => {
    d.classList.remove("done", "current");
    if (i < state.currentShotIndex) d.classList.add("done");
    else if (i === state.currentShotIndex) d.classList.add("current");
  });
}

/* -------- aperture (signature iris countdown) -------- */
function buildAperture() {
  const group = document.getElementById("aperture-blades");
  group.innerHTML = "";

  const defs = document.createElementNS(SVG_NS, "defs");
  const mask = document.createElementNS(SVG_NS, "mask");
  mask.setAttribute("id", "iris-mask");

  const maskBg = document.createElementNS(SVG_NS, "rect");
  maskBg.setAttribute("width", "200");
  maskBg.setAttribute("height", "200");
  maskBg.setAttribute("fill", "white");

  irisHole = document.createElementNS(SVG_NS, "circle");
  irisHole.setAttribute("cx", "100");
  irisHole.setAttribute("cy", "100");
  irisHole.setAttribute("r", "150");
  irisHole.setAttribute("fill", "black");

  mask.appendChild(maskBg);
  mask.appendChild(irisHole);
  defs.appendChild(mask);
  group.appendChild(defs);

  const cover = document.createElementNS(SVG_NS, "rect");
  cover.setAttribute("width", "200");
  cover.setAttribute("height", "200");
  cover.setAttribute("fill", "rgba(20,14,10,0.58)");
  cover.setAttribute("mask", "url(#iris-mask)");
  group.appendChild(cover);

  for (let i = 0; i < 8; i++) {
    const angle = ((i * 45) * Math.PI) / 180;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", "100");
    line.setAttribute("y1", "100");
    line.setAttribute("x2", 100 + Math.cos(angle) * 96);
    line.setAttribute("y2", 100 + Math.sin(angle) * 96);
    line.setAttribute("stroke", "rgba(255,255,255,0.14)");
    line.setAttribute("stroke-width", "1");
    group.appendChild(line);
  }

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("id", "iris-countdown");
  text.setAttribute("x", "100");
  text.setAttribute("y", "114");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", "42");
  text.setAttribute("fill", "white");
  text.setAttribute("font-family", "'Cormorant Garamond', serif");
  text.setAttribute("opacity", "0");
  group.appendChild(text);

  flashRect = document.createElementNS(SVG_NS, "rect");
  flashRect.setAttribute("width", "200");
  flashRect.setAttribute("height", "200");
  flashRect.setAttribute("fill", "white");
  flashRect.setAttribute("opacity", "0");
  group.appendChild(flashRect);
}

function setIrisRadius(r, ms = 280) {
  irisHole.style.transition = `r ${ms}ms ease`;
  irisHole.setAttribute("r", r);
}

function setCountdownText(t) {
  const el = document.getElementById("iris-countdown");
  if (t === "") {
    el.setAttribute("opacity", "0");
    return;
  }
  el.textContent = t;
  el.setAttribute("opacity", "0.9");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flashShutter() {
  return new Promise((resolve) => {
    flashRect.style.transition = "opacity 60ms ease";
    flashRect.setAttribute("opacity", "0.85");
    setTimeout(() => {
      flashRect.style.transition = "opacity 240ms ease";
      flashRect.setAttribute("opacity", "0");
      setTimeout(resolve, 240);
    }, 60);
  });
}

// Grabs ONE frame from the camera (filter + AR baked in).
function captureFrame() {
  const w = video.videoWidth || 960;
  const h = video.videoHeight || 720;
  captureCanvas.width = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext("2d");

  ctx.save();
  ctx.filter = getFilterById(state.filterId).css;
  ctx.translate(w, 0);
  ctx.scale(-1, 1);

  ctx.drawImage(video, 0, 0, w, h);

  const arCanvas = document.getElementById("ar-overlay-capture");
  if (arCanvas) {
    ctx.drawImage(arCanvas, 0, 0, w, h);
  }

  ctx.restore();

  return captureCanvas.toDataURL("image/jpeg", 0.92);
}

// Runs one countdown and snaps one photo. Returns the photo, or null if this
// run was cancelled (Cancel pressed, booth left) before the photo was taken.
async function runCountdownAndCapture(runId) {
  setIrisRadius(150, 10);
  setCountdownText("");

  const steps = [];
  for (let s = state.timerSeconds; s >= 1; s--) steps.push(s);

  for (let i = 0; i < steps.length; i++) {
    const n = steps[i];
    setCountdownText(n);
    const progress = (i + 1) / steps.length;
    const r = Math.max(150 - progress * 138, 12);
    setIrisRadius(r, 900);
    await wait(1000);
    if (runId !== captureRunId) return null;
  }

  setCountdownText("");
  setIrisRadius(4, 120);
  await wait(120);
  if (runId !== captureRunId) return null;

  const dataUrl = captureFrame();
  await flashShutter();
  setIrisRadius(150, 10);
  return dataUrl;
}

// Takes the whole set of shots. Returns true when finished, false if cancelled.
async function runShotSequence() {
  const runId = startCaptureRun();
  me().shots = [];
  state.currentShotIndex = 0;
  document.getElementById("total-shots").textContent = state.totalShots;
  buildShotProgressDots();
  applyLiveFilter();

  for (let i = 0; i < state.totalShots; i++) {
    state.currentShotIndex = i;
    document.getElementById("current-shot").textContent = i + 1;
    updateShotProgressDots();

    const shot = await runCountdownAndCapture(runId);
    if (shot === null) return false;
    me().shots.push(shot);

    await wait(400);
    if (runId !== captureRunId) return false;
  }
  state.currentShotIndex = state.totalShots;
  updateShotProgressDots();
  return true;
}