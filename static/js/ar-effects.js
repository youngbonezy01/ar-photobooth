// ar-effects.js

let activeEffects = { hat: false, noli: false, sunglasses: false, hearts: false };
let arAnimationFrameId = null; // tracks the currently running rAF loop, so we can cancel it cleanly
let faceLandmarker;
let handLandmarker;

// Smooths out the pointing-gesture detection so a single flickery frame
// doesn't make the sticker pop in and out. Requires the gesture to be
// held for a couple of consecutive frames before it "counts".
// Kept intentionally low (2) since pointing is an easy, stable pose to
// hold — a big hold count is what caused the earlier noticeable delay.
let fingerHeartStreak = 0;
const FINGER_HEART_HOLD_FRAMES = 2;

console.log("🔧 ar-effects.js loaded!");

// 1. Load the images
const images = { hat: new Image(), noli: new Image(), sunglasses: new Image(), hearts: new Image() };
images.hat.src = "/static/images/hat.png";
images.noli.src = "/static/images/noli.png";
images.sunglasses.src = "/static/images/sunglasses.png";
images.hearts.src = "/static/images/hearts.png";

images.hat.onload = () => console.log("✅ Hat image loaded successfully!");
images.hat.onerror = () => console.error("❌ Cannot find hat.png! Is it in static/images/?");

images.noli.onload = () => console.log("✅ Noli image loaded successfully!");
images.noli.onerror = () => console.error("❌ Cannot find noli.jpg! Is it in static/images/?");

images.sunglasses.onload = () => console.log("✅ Sunglasses image loaded successfully!");
images.sunglasses.onerror = () => console.error("❌ Cannot find sunglasses.png! Is it in static/images/?");

images.hearts.onload = () => console.log("✅ Hearts image loaded successfully!");
images.hearts.onerror = () => console.error("❌ Cannot find hearts.png! Is it in static/images/?");

// 2. Initialize MediaPipe
// NOTE: @mediapipe/tasks-vision ships as an ES module. It CANNOT be loaded
// with a plain <script src="..."> tag — that throws "Uncaught SyntaxError:
// Unexpected token 'export'" and silently prevents window.FaceLandmarker /
// window.FilesetResolver from ever being defined.
// Instead we dynamically import() it right here, which works fine from a
// classic script and doesn't require any <script type="module"> tag in HTML.
// IMPORTANT: remove the old vision_bundle.js <script> tag from index.html —
// it will keep throwing that SyntaxError otherwise.
async function initializeMediaPipe() {
  try {
    // Import the package ROOT (no filename) — jsDelivr resolves this to the
    // correct ESM entry point automatically. There is no "vision_bundle.mjs"
    // file at this version; that filename 404s.
    const vision = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0"
    );
    const { FaceLandmarker, FilesetResolver } = vision;

    const filesetResolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
    );

    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1
    });

    console.log("✅ MediaPipe FaceLandmarker loaded!");

    const { HandLandmarker } = vision;
    handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: 2
    });

    console.log("✅ MediaPipe HandLandmarker loaded!");
  } catch (error) {
    // If this logs a 404 or CORS error instead of the SyntaxError from before,
    // it means the import worked and this is a separate network/CDN issue.
    console.error("❌ MediaPipe error:", error);
  }
}

// 3. AR Loop
function startARLoop(videoElement, canvasElement) {
  if (!videoElement || !canvasElement) return;

  // Stop any previously running loop (e.g. the start-screen preview loop)
  // before starting a new one on a different video/canvas pair.
  // Previously a single global `isARRunning` flag caused the SECOND call
  // to startARLoop() (from the capture screen) to be silently ignored.
  stopARLoop();

  const ctx = canvasElement.getContext("2d");
  console.log("🎬 AR Loop started!");

  function detectAndDraw() {
    if (videoElement.readyState >= 2 && videoElement.videoWidth > 0) {
      canvasElement.width = videoElement.videoWidth;
      canvasElement.height = videoElement.videoHeight;
      ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

      const now = performance.now();

      try {
        // Added activeEffects.hearts so face tracking runs if only hearts is active
        if (faceLandmarker && (activeEffects.hat || activeEffects.sunglasses || activeEffects.hearts)) {
          const faceResults = faceLandmarker.detectForVideo(videoElement, now);
          if (faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
            drawFaceEffects(ctx, faceResults.faceLandmarks[0], canvasElement.width, canvasElement.height);
          }
        }
      } catch (e) {
        // Don't swallow errors silently — surface them so real bugs are visible
        console.error("Face detect/draw error:", e);
      }

      try {
        if (handLandmarker && activeEffects.noli) {
          const handResults = handLandmarker.detectForVideo(videoElement, now);
          drawNoliSticker(ctx, handResults, canvasElement.width, canvasElement.height);
        }
      } catch (e) {
        console.error("Hand detect/draw error:", e);
      }
    }
    arAnimationFrameId = requestAnimationFrame(detectAndDraw);
  }
  detectAndDraw();
}

function stopARLoop() {
  if (arAnimationFrameId !== null) {
    cancelAnimationFrame(arAnimationFrameId);
    arAnimationFrameId = null;
  }
}

// 4. Draw the Hat + Sunglasses + Hearts
// Face landmark indices used below (standard 468-point face mesh, always
// present regardless of iris refinement settings):
//   10 = top of head, 234 = left ear/temple, 454 = right ear/temple
//   33 = right eye outer corner, 133 = right eye inner corner
//   362 = left eye inner corner, 263 = left eye outer corner
// 4. Draw the Hat + Sunglasses + Hearts
function drawFaceEffects(ctx, landmarks, w, h) {
  const getPoint = (idx) => ({ x: landmarks[idx].x * w, y: landmarks[idx].y * h });

  // --- HEARTS EFFECT ---
  if (activeEffects.hearts && images.hearts.complete) {
    // Calculate the bounding box of the face
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const lm of landmarks) {
      if (lm.x < minX) minX = lm.x;
      if (lm.x > maxX) maxX = lm.x;
      if (lm.y < minY) minY = lm.y;
      if (lm.y > maxY) maxY = lm.y;
    }

    const faceWidth = (maxX - minX) * w;
    const heartsSize = faceWidth * 0.6; // Adjust size multiplier as needed

    // 🪞 THE MIRROR FIX:
    // Selfie cameras are usually mirrored on screen, meaning the "right" side
    // of the screen is actually the "left" side of the raw video data (minX).
    // We subtract heartsSize so it sits just outside the right side of the face on screen.
    const topRightX = (minX * w) - heartsSize;
    const topRightY = (minY * h) - (heartsSize * 0.8); // Floats nicely above the head

    ctx.save();
    ctx.drawImage(images.hearts, topRightX, topRightY, heartsSize, heartsSize);
    ctx.restore();

    /* 
     * 🛑 ALTERNATIVE: Fixed to the absolute top-right corner of the SCREEN
     * If you want the hearts to stay pinned to the top-right corner of the 
     * screen (and NOT track the person's head at all), comment out the 
     * drawImage code above and uncomment this instead:
     *
     * const fixedHeartsSize = w * 0.25; // 25% of screen width
     * ctx.drawImage(images.hearts, w - fixedHeartsSize, 0, fixedHeartsSize, fixedHeartsSize);
     */
  }

  // --- HAT EFFECT ---
  if (activeEffects.hat && images.hat.complete) {
    const topHead = getPoint(10);
    const leftEar = getPoint(234);
    const rightEar = getPoint(454);

    const faceWidth = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);
    const angle = Math.atan2(rightEar.y - leftEar.y, rightEar.x - leftEar.x);
    const hatSize = faceWidth * 1.2;

    ctx.save();
    ctx.translate(topHead.x, topHead.y);
    ctx.rotate(angle);
    ctx.drawImage(images.hat, -hatSize / 2, -hatSize * 0.8, hatSize, hatSize);
    ctx.restore();
  }

  // --- SUNGLASSES EFFECT ---
  if (activeEffects.sunglasses && images.sunglasses.complete) {
    const rightEyeOuter = getPoint(33);
    const leftEyeOuter = getPoint(263);

    const eyeSpan = Math.hypot(leftEyeOuter.x - rightEyeOuter.x, leftEyeOuter.y - rightEyeOuter.y);
    const angle = Math.atan2(leftEyeOuter.y - rightEyeOuter.y, leftEyeOuter.x - rightEyeOuter.x);
    const centerX = (rightEyeOuter.x + leftEyeOuter.x) / 2;
    const centerY = (rightEyeOuter.y + leftEyeOuter.y) / 2;

    const glassesWidth = eyeSpan * 1.7;
    const aspectRatio = (images.sunglasses.naturalHeight / images.sunglasses.naturalWidth) || 0.4;
    const glassesHeight = glassesWidth * aspectRatio;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(angle);
    ctx.drawImage(images.sunglasses, -glassesWidth / 2, -glassesHeight / 2, glassesWidth, glassesHeight);
    ctx.restore();
  }
}

// 5. Pointing Gesture Detection + Noli Sticker
// MediaPipe HandLandmarker returns 21 points per hand. Key indices:
//   0 = wrist, 6 = index PIP, 8 = index tip, 9 = middle MCP (knuckle),
//   10 = middle PIP, 12 = middle tip, 14 = ring PIP, 16 = ring tip,
//   18 = pinky PIP, 20 = pinky tip
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

// A finger is "curled" if its tip sits closer to the wrist than its own
// middle (PIP) knuckle does — i.e. the finger has folded back toward the palm
// instead of pointing outward.
function isFingerCurled(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  return dist(landmarks[tipIdx], wrist) < dist(landmarks[pipIdx], wrist);
}

// "Pointing": index finger extended (not curled) while middle/ring/pinky
// are curled into the palm. Thumb position isn't checked — people point
// with their thumb in all sorts of positions, so leaving it out makes this
// register faster and more reliably than the old pinch gesture did.
function isPointing(landmarks) {
  const indexExtended = !isFingerCurled(landmarks, 8, 6);
  const middleCurled = isFingerCurled(landmarks, 12, 10);
  const ringCurled = isFingerCurled(landmarks, 16, 14);
  const pinkyCurled = isFingerCurled(landmarks, 20, 18);

  return indexExtended && middleCurled && ringCurled && pinkyCurled;
}

function drawNoliSticker(ctx, handResults, w, h) {
  if (!handResults.landmarks || handResults.landmarks.length === 0) {
    fingerHeartStreak = 0;
    return;
  }

  // Check every detected hand; if any one is making the gesture, count it.
  const gestureHand = handResults.landmarks.find(isPointing);

  if (!gestureHand) {
    fingerHeartStreak = 0;
    return;
  }

  fingerHeartStreak++;
  if (fingerHeartStreak < FINGER_HEART_HOLD_FRAMES) return; // brief hold, now much shorter (see const below)
  if (!images.noli.complete || images.noli.naturalWidth === 0) return; // image not ready yet

  const indexTip = { x: gestureHand[8].x * w, y: gestureHand[8].y * h };

  const wrist = { x: gestureHand[0].x * w, y: gestureHand[0].y * h };
  const middleMcp = { x: gestureHand[9].x * w, y: gestureHand[9].y * h };
  const handSizePx = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);

  // 👇 Lower this multiplier to shrink the sticker further (e.g. 0.5, 0.4...)
  const stickerSize = handSizePx * 0.7;

  // Float it just above the fingertip, then clamp so it can never spill
  // outside the visible canvas/video area.
  const half = stickerSize / 2;
  const targetX = indexTip.x;
  const targetY = indexTip.y - stickerSize * 0.6;
  const drawX = Math.min(Math.max(targetX, half), w - half);
  const drawY = Math.min(Math.max(targetY, half), h - half);

  ctx.save();
  ctx.translate(drawX, drawY);
  ctx.drawImage(images.noli, -half, -half, stickerSize, stickerSize);
  ctx.restore();
}

// 6. UI Listeners
document.addEventListener("DOMContentLoaded", () => {
  initializeMediaPipe();
  document.querySelectorAll(".effect-toggle").forEach(checkbox => {
    checkbox.addEventListener("change", (e) => {
      activeEffects[e.target.dataset.effect] = e.target.checked;
    });
  });
});

window.startARLoop = startARLoop;
window.stopARLoop = stopARLoop;