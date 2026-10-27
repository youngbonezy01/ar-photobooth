/* ==========================================
   AI SCENE DETECTION & PROPS (COMPLETE FIX)
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
  nature: ['🍃', '🌸', '', '🦋', '', '🍄'],
  default: ['✨', '🌟', '', '⭐']
};

let currentMood = 'default';
let analysisInterval;
let isMagicPropsEnabled = false;
let currentVideoElement = null;

// 3. The "AI" Scene Analyzer
function analyzeScene(videoElement) {
  if (!videoElement || videoElement.readyState !== videoElement.HAVE_ENOUGH_DATA) {
    return;
  }
  
  // Draw the current video frame to our tiny hidden canvas
  try {
    analysisCtx.drawImage(videoElement, 0, 0, analysisCanvas.width, analysisCanvas.height);
  } catch (e) {
    console.error('Error drawing video to canvas:', e);
    return;
  }
  
  // Get the pixel data
  const imageData = analysisCtx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
  const data = imageData.data;
  
  let totalBrightness = 0;
  let totalRed = 0;
  let totalGreen = 0;
  let totalBlue = 0;
  let pixelCount = data.length / 4;

  // Loop through pixels
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    
    const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
    totalBrightness += brightness;
    totalRed += r;
    totalGreen += g;
    totalBlue += b;
  }

  const avgBrightness = totalBrightness / pixelCount;
  const avgRed = totalRed / pixelCount;
  const avgGreen = totalGreen / pixelCount;
  const avgBlue = totalBlue / pixelCount;

  // Determine the Mood
  let detectedMood = 'default';

  if (avgBrightness < 60) {
    detectedMood = 'night';
  } else if (avgRed > avgBlue + 20 && avgRed > avgGreen + 10) {
    detectedMood = 'romantic';
  } else if (avgGreen > avgRed && avgGreen > avgBlue) {
    detectedMood = 'nature';
  } else if (avgBrightness > 120) {
    detectedMood = 'party';
  }

  // Only update if mood changed
  if (detectedMood !== currentMood) {
    currentMood = detectedMood;
    console.log('🎨 Scene mood changed to:', currentMood);
    updateProps();
  }
}

// 4. Function to spawn the props
function updateProps() {
  // Get BOTH containers
  const previewContainer = document.getElementById('ar-props-container-preview');
  const captureContainer = document.getElementById('ar-props-container-capture');
  
  // Clear both
  if (previewContainer) previewContainer.innerHTML = '';
  if (captureContainer) captureContainer.innerHTML = '';
  
  // Determine which one to use based on which screen is active
  const screenStart = document.getElementById('screen-start');
  const screenCapture = document.getElementById('screen-capture');
  
  let activeContainer = null;
  
  if (screenStart && screenStart.classList.contains('active')) {
    activeContainer = previewContainer;
  } else if (screenCapture && screenCapture.classList.contains('active')) {
    activeContainer = captureContainer;
  }
  
  if (!activeContainer) {
    console.log('No active container found');
    return;
  }
  
  const propsToUse = moodProps[currentMood] || moodProps.default;
  const numberOfProps = 8;

  for (let i = 0; i < numberOfProps; i++) {
    createProp(activeContainer, propsToUse);
  }
  
  console.log('✨ Props created in container');
}

function createProp(container, propsList) {
  if (!container) return;
  
  const prop = document.createElement('div');
  prop.classList.add('floating-prop');
  
  // Pick a random emoji
  const randomProp = propsList[Math.floor(Math.random() * propsList.length)];
  prop.textContent = randomProp || '✨';
  
  // Spawn on edges only (avoid center where face is)
  const side = Math.random();
  let leftPos, topPos;
  
  if (side < 0.25) {
    leftPos = Math.random() * 15;
    topPos = 10 + Math.random() * 80;
  } else if (side < 0.5) {
    leftPos = 85 + Math.random() * 15;
    topPos = 10 + Math.random() * 80;
  } else if (side < 0.75) {
    leftPos = Math.random() * 100;
    topPos = Math.random() * 15;
  } else {
    leftPos = Math.random() * 100;
    topPos = 85 + Math.random() * 15;
  }

  prop.style.left = `${leftPos}%`;
  prop.style.top = `${topPos}%`;
  
  // Small size for background effect
  const size = 0.8 + Math.random() * 0.8;
  prop.style.fontSize = `${size}rem`;
  
  // Slow, dreamy animation
  prop.style.animationDuration = `${8 + Math.random() * 5}s`;
  prop.style.animationDelay = `${Math.random() * 3}s`;
  
  container.appendChild(prop);
}

// 5. Start/Stop Controls
function startSceneDetection(videoElement) {
  if (!videoElement) {
    console.error('No video element provided to startSceneDetection');
    return;
  }
  
  currentVideoElement = videoElement;
  
  // Clear existing interval
  if (analysisInterval) {
    clearInterval(analysisInterval);
  }
  
  // Run analyzer every second
  analysisInterval = setInterval(() => {
    if (isMagicPropsEnabled && videoElement.readyState === videoElement.HAVE_ENOUGH_DATA) {
      analyzeScene(videoElement);
    }
  }, 1000);
  
  console.log('🎬 Scene detection started');
}

function stopSceneDetection() {
  if (analysisInterval) {
    clearInterval(analysisInterval);
    analysisInterval = null;
  }
  
  // Clear both containers
  const previewContainer = document.getElementById('ar-props-container-preview');
  const captureContainer = document.getElementById('ar-props-container-capture');
  
  if (previewContainer) previewContainer.innerHTML = '';
  if (captureContainer) captureContainer.innerHTML = '';
  
  console.log('⏹️ Scene detection stopped');
}

// 6. Toggle Button Function
function toggleMagicProps() {
  isMagicPropsEnabled = !isMagicPropsEnabled;
  const btn = document.getElementById('magic-props-btn');
  
  if (!btn) {
    console.error('Magic props button not found!');
    return;
  }
  
  if (isMagicPropsEnabled) {
    btn.classList.add('active');
    btn.querySelector('.text').textContent = 'Ambient Magic: ON';
    
    // Start with the appropriate video
    const previewVideo = document.getElementById('preview-video');
    const cameraFeed = document.getElementById('camera-feed');
    
    const screenStart = document.getElementById('screen-start');
    const screenCapture = document.getElementById('screen-capture');
    
    if (screenStart && screenStart.classList.contains('active') && previewVideo) {
      startSceneDetection(previewVideo);
    } else if (screenCapture && screenCapture.classList.contains('active') && cameraFeed) {
      startSceneDetection(cameraFeed);
    }
    
    console.log('✨ Magic props ENABLED');
  } else {
    btn.classList.remove('active');
    btn.querySelector('.text').textContent = 'Ambient Magic: OFF';
    stopSceneDetection();
    console.log('⭕ Magic props DISABLED');
  }
}

// Debug: Log when script loads
console.log('✅ AI Props script loaded successfully');