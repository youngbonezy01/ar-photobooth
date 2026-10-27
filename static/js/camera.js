const SVG_NS = "http://www.w3.org/2000/svg";

const video = document.getElementById("camera-feed");
const previewVideo = document.getElementById("preview-video");
const captureCanvas = document.getElementById("capture-canvas");

let mediaStream = null;
let capturedShots = [];   // dataURLs, in order, filter already baked in
let totalShots = 4;
let currentShotIndex = 0;
let selectedTimerSeconds = 3;
let irisHole, flashRect;

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
    
    document.getElementById("camera-error").hidden = true;
    return true;
  } catch (err) {
    document.getElementById("camera-error").hidden = false;
    return false;
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  stopSceneDetection();
}

// 👇 Apply filter to BOTH the preview and the capture video
function applyLiveFilter() {
  const filterCss = getFilterById(activeFilterId).css;
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
  for (let i = 0; i < totalShots; i++) {
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
    if (i < currentShotIndex) d.classList.add("done");
    else if (i === currentShotIndex) d.classList.add("current");
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

function captureFrame() {
  const w = video.videoWidth || 960;
  const h = video.videoHeight || 720;
  captureCanvas.width = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext("2d");

  ctx.save();
  ctx.filter = getFilterById(activeFilterId).css;
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

async function runCountdownAndCapture() {
  setIrisRadius(150, 10);
  setCountdownText("");

  const steps = [];
  for (let s = selectedTimerSeconds; s >= 1; s--) steps.push(s);

  for (let i = 0; i < steps.length; i++) {
    const n = steps[i];
    setCountdownText(n);
    const progress = (i + 1) / steps.length;
    const r = Math.max(150 - progress * 138, 12);
    setIrisRadius(r, 900);
    await wait(1000);
  }

  setCountdownText("");
  setIrisRadius(4, 120);
  await wait(120);
  const dataUrl = captureFrame();
  await flashShutter();
  setIrisRadius(150, 10);
  return dataUrl;
}

async function runShotSequence() {
  capturedShots = [];
  currentShotIndex = 0;
  document.getElementById("total-shots").textContent = totalShots;
  buildShotProgressDots();
  applyLiveFilter();

  for (let i = 0; i < totalShots; i++) {
    currentShotIndex = i;
    document.getElementById("current-shot").textContent = i + 1;
    updateShotProgressDots();
    const shot = await runCountdownAndCapture();
    capturedShots.push(shot);
    await wait(400);
  }
  currentShotIndex = totalShots;
  updateShotProgressDots();
}


/* ==========================================
   AI SCENE DETECTION & PROPS (CLEANED UP)
   ========================================== */

// 1. Setup the hidden canvas for analyzing the video
const analysisCanvas = document.createElement('canvas');
const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
analysisCanvas.width = 64;
analysisCanvas.height = 48;

// 2. Define our "Moods" and their matching props
const moodProps = {
  party: ['🎈', '🎉', '✨', '🦋', '🌟', '🎊', '🍾'],
  night: ['✨', '🌙', '⭐', '🦇', '', '💫'],
  romantic: ['', '🌹', '💕', '🦢', '', '💌'],
  nature: ['🍃', '🌸', '🌻', '🦋', '', '🍄'],
  default: ['✨', '🌟', '', '⭐']
};

let currentMood = 'default';
let analysisInterval;
let isMagicPropsEnabled = false;

// 3. The "AI" Scene Analyzer
function analyzeScene(videoElement) {
  if (!videoElement || videoElement.readyState !== videoElement.HAVE_ENOUGH_DATA) return;
  
  try {
    analysisCtx.drawImage(videoElement, 0, 0, analysisCanvas.width, analysisCanvas.height);
  } catch (e) { return; }
  
  const imageData = analysisCtx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  const data = imageData.data;
  
  let totalBrightness = 0, totalRed = 0, totalGreen = 0, totalBlue = 0;
  let pixelCount = data.length / 4;

  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    totalBrightness += (r * 0.299 + g * 0.587 + b * 0.114);
    totalRed += r; totalGreen += g; totalBlue += b;
  }

  const avgBrightness = totalBrightness / pixelCount;
  const avgRed = totalRed / pixelCount;
  const avgGreen = totalGreen / pixelCount;
  const avgBlue = totalBlue / pixelCount;

  let detectedMood = 'default';
  if (avgBrightness < 60) detectedMood = 'night';
  else if (avgRed > avgBlue + 20 && avgRed > avgGreen + 10) detectedMood = 'romantic';
  else if (avgGreen > avgRed && avgGreen > avgBlue) detectedMood = 'nature';
  else if (avgBrightness > 120) detectedMood = 'party';

  if (detectedMood !== currentMood) {
    currentMood = detectedMood;
    updateProps();
  }
}

// 4. Function to spawn the props
function updateProps() {
  const previewContainer = document.getElementById('ar-props-container-preview');
  const captureContainer = document.getElementById('ar-props-container-capture');
  
  if (previewContainer) previewContainer.innerHTML = '';
  if (captureContainer) captureContainer.innerHTML = '';
  
  const screenStart = document.getElementById('screen-start');
  const screenCapture = document.getElementById('screen-capture');
  
  let activeContainer = null;
  if (screenStart && screenStart.classList.contains('active')) activeContainer = previewContainer;
  else if (screenCapture && screenCapture.classList.contains('active')) activeContainer = captureContainer;
  
  if (!activeContainer) return;
  
  const propsToUse = moodProps[currentMood] || moodProps.default;
  for (let i = 0; i < 8; i++) createProp(activeContainer, propsToUse);
}

function createProp(container, propsList) {
  if (!container) return;
  const prop = document.createElement('div');
  prop.classList.add('floating-prop');
  prop.textContent = propsList[Math.floor(Math.random() * propsList.length)] || '✨';
  
  const side = Math.random();
  let leftPos, topPos;
  if (side < 0.25) { leftPos = Math.random() * 15; topPos = 10 + Math.random() * 80; }
  else if (side < 0.5) { leftPos = 85 + Math.random() * 15; topPos = 10 + Math.random() * 80; }
  else if (side < 0.75) { leftPos = Math.random() * 100; topPos = Math.random() * 15; }
  else { leftPos = Math.random() * 100; topPos = 85 + Math.random() * 15; }

  prop.style.left = `${leftPos}%`;
  prop.style.top = `${topPos}%`;
  prop.style.fontSize = `${0.8 + Math.random() * 0.8}rem`;
  prop.style.animationDuration = `${8 + Math.random() * 5}s`;
  prop.style.animationDelay = `${Math.random() * 3}s`;
  
  container.appendChild(prop);
}

// 5. Start/Stop Controls
function startSceneDetection(videoElement) {
  if (!videoElement) return;
  if (analysisInterval) clearInterval(analysisInterval);
  
  analysisInterval = setInterval(() => {
    if (isMagicPropsEnabled && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
      analyzeScene(videoElement);
    }
  }, 1000);
}

function stopSceneDetection() {
  if (analysisInterval) clearInterval(analysisInterval);
  const pc = document.getElementById('ar-props-container-preview');
  const cc = document.getElementById('ar-props-container-capture');
  if (pc) pc.innerHTML = '';
  if (cc) cc.innerHTML = '';
}

// 6. Toggle Button Function
function toggleMagicProps() {
  isMagicPropsEnabled = !isMagicPropsEnabled;
  const btn = document.getElementById('magic-props-btn');
  if (!btn) return;
  
  const textSpan = btn.querySelector('.text');
  
  if (isMagicPropsEnabled) {
    btn.classList.add('active');
    if (textSpan) textSpan.textContent = 'Ambient Magic: ON';
    
    const pv = document.getElementById('preview-video');
    const cf = document.getElementById('camera-feed');
    const ss = document.getElementById('screen-start');
    const sc = document.getElementById('screen-capture');
    
    if (ss && ss.classList.contains('active') && pv) startSceneDetection(pv);
    else if (sc && sc.classList.contains('active') && cf) startSceneDetection(cf);
  } else {
    btn.classList.remove('active');
    if (textSpan) textSpan.textContent = 'Ambient Magic: OFF';
    stopSceneDetection();
  }
}