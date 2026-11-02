// room.js — booths: create/join, host settings, synced start, photo upload,
// the shared sheet, and shared stickers. Talks to the Flask-SocketIO backend in app.py.

const room = {
  socket: null,
  code: null,            // e.g. "K7QM-4X9P" once we're inside a booth
  myId: null,
  hostId: null,
  started: false,
  settings: null,        // { totalShots, timerSeconds, template }
  members: [],           // [{ id, name }]
  readyIds: [],          // member ids whose camera is open
  doneIds: [],           // member ids who have uploaded their photos
  busy: false,
  starting: false,       // "Starting in 3…" has begun
  prepared: false,       // our camera is open and we told the server "ready"
  beginReceived: false,  // the server said "go" (maybe before our camera was open)
  shooting: false,       // our shots are being taken
  sheetParts: [],        // photos of each person, arriving one message at a time
  sheetReceived: false,  // the shared sheet is on this device
};

const TIMER_CHOICES = [3, 5, 10];
const TEMPLATE_CHOICES = ["cream", "pink", "red", "black"];

// Photos are shrunk before upload: a 6-person booth is 36 photos
const SHARE_W = 480;
const SHARE_H = 360;
const SHARE_QUALITY = 0.78;
const SAFE_SHOT = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

/* -------------------------------------------------- small helpers */

// "k7qm4x9p" -> "K7QM-4X9P" (also used while typing)
function formatCode(raw) {
  const letters = String(raw || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return letters.length > 4 ? letters.slice(0, 4) + "-" + letters.slice(4) : letters;
}

function isHost() {
  return !!room.myId && room.myId === room.hostId;
}

function showRoomError(message) {
  ["room-error", "lobby-error", "waiting-error"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  });
}

function setLobbyStatus(text) {
  const el = document.getElementById("lobby-status");
  if (el) el.textContent = text || "";
}

function setBusy(isBusy) {
  room.busy = isBusy;
  ["btn-create-booth", "btn-join-booth"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = isBusy;
  });
}

function resetRoom() {
  room.code = null;
  room.myId = null;
  room.hostId = null;
  room.started = false;
  room.settings = null;
  room.members = [];
  room.readyIds = [];
  room.doneIds = [];
  room.starting = false;
  room.prepared = false;
  room.beginReceived = false;
  room.shooting = false;
  room.sheetParts = [];
  room.sheetReceived = false;
  document.body.classList.remove("in-booth");
  updateBoothWaitNote();
  setLobbyStatus("");
  setBusy(false);
}

// Called by app.js when someone presses Cancel / Start over / Take new photos:
// if we're in a booth, quietly leave it (the caller handles the screen).
function exitBoothIfAny() {
  if (room.code && room.socket && room.socket.connected) room.socket.emit("leave_room");
  resetRoom();
}

// Back to the start screen, with an optional message. Used when something
// goes wrong mid-booth (camera failed, connection lost, booth closed).
function abortToStart(message) {
  cancelCapture();
  exitBoothIfAny();
  stopCamera();
  resetSession();
  showScreen("start");
  startPreviewCamera();
  showRoomError(message || "");
}

function inviteLink() {
  return `${location.origin}${location.pathname}?join=${room.code}`;
}

// Clipboard needs a secure page (localhost and https are fine); fall back
// to the old select-and-copy trick if it's blocked.
async function copyText(text, button) {
  const original = button.textContent;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    const box = document.createElement("textarea");
    box.value = text;
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    box.remove();
  }
  button.textContent = ok ? "Copied!" : "Select it and press Ctrl+C";
  setTimeout(() => { button.textContent = original; }, 1500);
}

/* -------------------------------------------------- "who are we waiting for?" note */

// A small line under "Get ready — shot 1 of 4" on the capture screen. It's
// created here so index.html doesn't need to change.
(function addBoothWaitNote() {
  const hint = document.getElementById("capture-hint");
  if (!hint) return;
  const note = document.createElement("p");
  note.id = "booth-wait-note";
  note.className = "booth-wait-note";
  note.hidden = true;
  hint.insertAdjacentElement("afterend", note);
})();

// Shown after OUR camera is open, until everyone's is and the countdowns begin.
function updateBoothWaitNote() {
  const el = document.getElementById("booth-wait-note");
  if (!el) return;

  const waiting = !!room.code && room.prepared && !room.shooting && !room.sheetReceived;
  if (!waiting) {
    el.hidden = true;
    el.textContent = "";
    return;
  }

  const names = room.members
    .filter((m) => !room.readyIds.includes(m.id))
    .map((m) => m.name);
  // textContent (never innerHTML) so a name can't inject HTML
  el.textContent = names.length ? `Waiting for ${names.join(", ")}…` : "Starting…";
  el.hidden = false;
}

/* -------------------------------------------------- socket setup */

function getSocket() {
  if (room.socket) return room.socket;

  if (typeof io === "undefined") {
    showRoomError("Couldn't load the booth connection. Check your internet and refresh.");
    return null;
  }

  // autoConnect:false = nothing connects until someone creates or joins a booth
  const socket = io({ autoConnect: false });
  room.socket = socket;

  socket.on("joined", (data) => {
    room.code = data.code;
    room.myId = data.myId;
    setBusy(false);
    showRoomError("");
    showScreen("lobby");
  });

  socket.on("room_update", (data) => {
    room.code = data.code;
    room.hostId = data.hostId;
    room.started = data.started;
    room.settings = data.settings;
    room.members = data.members;
    room.readyIds = data.readyIds || [];
    room.doneIds = data.doneIds || [];
    renderLobby();
    renderWaiting();
    updateBoothWaitNote();
  });

  socket.on("booth_started", (data) => {
    startBoothSequence(data);
  });

  // Every camera is open: all countdowns begin now
  socket.on("begin_capture", () => {
    if (room.prepared) {
      runBoothShots();
      updateBoothWaitNote();
    } else {
      room.beginReceived = true;     // our camera is still opening; go as soon as it's ready
    }
  });

  socket.on("sheet_person", (person) => {
    room.sheetParts.push(person);
  });

  socket.on("sheet_done", () => {
    buildSharedSheet();
  });

  // The server's list of stickers replaces ours every time it changes
  socket.on("stickers_update", (data) => {
    const list = Array.isArray(data && data.stickers) ? data.stickers : [];
    const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 1;

    state.stickers = list
      .map((s) => ({
        uid: String(s.uid),
        id: s.id,
        glyph: stickerGlyph(s.id),        // unknown ids come out empty and are dropped below
        xPct: Number(s.xPct),
        yPct: Number(s.yPct),
      }))
      .filter((s) => s.glyph && inRange(s.xPct) && inRange(s.yPct));

    if (document.getElementById("screen-export").classList.contains("active")) {
      renderPlacedStickerList();
      renderStrip(state.template);
    }
  });

  socket.on("room_error", (data) => {
    setBusy(false);
    showRoomError(data.message);
    if (room.code) renderLobby();   // e.g. re-enable Start if the server said no
  });

  socket.on("room_closed", () => {
    // Already holding the finished sheet? Keep showing it.
    if (room.sheetReceived) { room.code = null; return; }
    abortToStart("That booth was closed. Make a new one or join another.");
  });

  socket.on("disconnect", () => {
    if (!room.code) return;            // we left on purpose, nothing to report
    if (room.sheetReceived) { room.code = null; return; }
    abortToStart("Lost the connection to the booth.");
  });

  socket.on("connect_error", () => {
    setBusy(false);
    showRoomError("Couldn't reach the server. Try again in a moment.");
  });

  return socket;
}

// Opens the connection if needed, then runs fn.
function withConnection(fn) {
  const socket = getSocket();
  if (!socket) return;
  if (socket.connected) {
    fn(socket);
  } else {
    socket.once("connect", () => fn(socket));
    socket.connect();
  }
}

/* -------------------------------------------------- actions */

function createBooth() {
  if (room.busy) return;
  showRoomError("");
  setBusy(true);
  const name = document.getElementById("player-name").value;
  withConnection((socket) => socket.emit("create_room", { name }));
}

function joinBooth() {
  if (room.busy) return;
  const code = formatCode(document.getElementById("join-code").value);
  if (code.length < 9) {
    showRoomError("Enter the full 8-character code, like K7QM-4X9P.");
    return;
  }
  showRoomError("");
  setBusy(true);
  const name = document.getElementById("player-name").value;
  withConnection((socket) => socket.emit("join_room", { name, code }));
}

function leaveBooth() {
  if (room.socket && room.socket.connected) room.socket.emit("leave_room");
  resetRoom();
  showRoomError("");
  showScreen("start");
}

// Host only. The server double-checks, this just avoids pointless messages.
function sendSettings(patch) {
  if (!isHost() || room.started) return;
  if (room.socket && room.socket.connected) room.socket.emit("update_settings", patch);
}

function startBooth() {
  if (!isHost() || room.started) return;
  document.getElementById("btn-start-booth").disabled = true;
  if (room.socket && room.socket.connected) room.socket.emit("start_booth");
}

/* -------------------------------------------------- starting the booth */

// Copies the host's settings into our own state and the start-screen controls.
function applyBoothSettings(s) {
  if (!s) return;
  if (Number.isInteger(s.totalShots)) {
    state.totalShots = Math.max(MIN_SHOTS, Math.min(MAX_SHOTS, s.totalShots));
  }
  if (TIMER_CHOICES.includes(s.timerSeconds)) state.timerSeconds = s.timerSeconds;
  if (TEMPLATE_CHOICES.includes(s.template)) state.template = s.template;

  updateStepperUI();
  document.querySelectorAll(".timer-chip").forEach((c) => {
    c.classList.toggle("active", parseInt(c.dataset.timer, 10) === state.timerSeconds);
  });
  setActiveTemplateSwatch(state.template);
}

async function startBoothSequence(data) {
  if (room.starting) return;
  room.starting = true;
  room.prepared = false;
  room.beginReceived = false;
  room.sheetReceived = false;
  room.sheetParts = [];
  showRoomError("");
  applyBoothSettings(data && data.settings);

  // Everyone counts down together so the cameras begin opening at the same moment
  let seconds = data && Number.isInteger(data.startIn) ? data.startIn : 3;
  while (seconds > 0) {
    setLobbyStatus(`Starting in ${seconds}…`);
    await wait(1000);
    if (!room.starting || !room.code) return;   // we left the booth meanwhile
    seconds--;
  }
  setLobbyStatus("");

  resetSession();
  const mine = room.members.find((m) => m.id === room.myId);
  if (mine) me().name = mine.name;

  // Open the camera, then tell the server we're ready. The server says
  // "begin_capture" once EVERYONE is ready, so all countdowns start together.
  const opened = await openCaptureScreen();
  if (!room.starting || !room.code) return;     // left while the camera was opening
  if (!opened) {
    abortToStart("Your camera isn't available, so you left the booth.");
    return;
  }

  room.prepared = true;
  updateBoothWaitNote();
  room.socket.emit("ready");
  if (room.beginReceived) {
    runBoothShots();                            // the "go" arrived while we were still opening
    updateBoothWaitNote();
  }
}

async function runBoothShots() {
  if (room.shooting) return;
  room.shooting = true;
  updateBoothWaitNote();
  const finished = await runShotSequence();
  if (!finished || !room.code) return;          // cancelled or left the booth
  await finishBoothShots();
}

// Scales a photo down so a 6-person booth doesn't send megabytes
async function shrinkShot(dataUrl) {
  const img = await loadImage(dataUrl);          // loadImage / coverRect live in strip.js
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_W;
  canvas.height = SHARE_H;
  const { sx, sy, sw, sh } = coverRect(img, SHARE_W, SHARE_H);
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, SHARE_W, SHARE_H);
  return canvas.toDataURL("image/jpeg", SHARE_QUALITY);
}

async function finishBoothShots() {
  stopCamera();
  showScreen("waiting");
  renderWaiting();

  try {
    const shots = await Promise.all(me().shots.map(shrinkShot));
    if (!room.code) return;                      // left while shrinking
    room.socket.emit("submit_shots", { shots });
  } catch (e) {
    showRoomError("Couldn't send your photos. Leave the booth and try again.");
  }
}

/* -------------------------------------------------- the shared sheet */

function buildSharedSheet() {
  const parts = room.sheetParts;
  room.sheetParts = [];

  // Keep our own full-quality photos for our own column
  const myLocalShots = me() ? me().shots.slice() : [];

  const participants = parts
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || "").slice(0, 14),
      shots: Array.isArray(p.shots) ? p.shots.filter((s) => typeof s === "string" && SAFE_SHOT.test(s)) : [],
    }))
    .filter((p) => p.shots.length > 0);

  if (!participants.some((p) => p.id === room.myId)) {
    abortToStart("Your photos didn't make it into the sheet in time. Try another booth.");
    return;
  }

  participants.forEach((p) => {
    if (p.id === room.myId && myLocalShots.length === p.shots.length) p.shots = myLocalShots;
  });

  state.participants = participants;
  state.myId = room.myId;
  room.sheetReceived = true;
  document.body.classList.add("in-booth");      // hides the Retake buttons, turns on shared stickers
  updateBoothWaitNote();

  setActiveTemplateSwatch(state.template);
  showScreen("review");
  renderShotThumbnails();
}

/* -------------------------------------------------- lobby + waiting screens */

// One person row, used by both the lobby and the waiting screen.
// badges = [{ text, cls }]
function makeMemberRow(member, index, badges) {
  const row = document.createElement("li");
  row.className = "member-row";

  const avatar = document.createElement("span");
  avatar.className = "member-avatar";
  avatar.textContent = (Array.from(member.name)[0] || "?").toUpperCase();
  avatar.style.background = `hsl(${(index * 57 + 330) % 360}, 55%, 55%)`;
  row.appendChild(avatar);

  // textContent (never innerHTML) so a name can't inject HTML
  const name = document.createElement("span");
  name.className = "member-name";
  name.textContent = member.name;
  row.appendChild(name);

  badges.forEach((b) => {
    const badge = document.createElement("span");
    badge.className = "badge" + (b.cls ? " " + b.cls : "");
    badge.textContent = b.text;
    row.appendChild(badge);
  });

  return row;
}

function renderLobby() {
  const codeEl = document.getElementById("lobby-code");
  if (codeEl) codeEl.textContent = room.code || "----";

  const count = document.getElementById("people-count");
  if (count) count.textContent = `(${room.members.length} / ${MAX_PEOPLE})`;

  const list = document.getElementById("member-list");
  if (list) {
    list.innerHTML = "";
    room.members.forEach((m, i) => {
      const badges = [];
      if (m.id === room.hostId) badges.push({ text: "host" });
      if (m.id === room.myId) badges.push({ text: "you", cls: "badge--you" });
      list.appendChild(makeMemberRow(m, i, badges));
    });
  }

  renderLobbySettings();
}

function renderWaiting() {
  const list = document.getElementById("waiting-list");
  const count = document.getElementById("waiting-count");
  if (!list || !count) return;

  const done = room.members.filter((m) => room.doneIds.includes(m.id)).length;
  count.textContent = `${done} of ${room.members.length} finished`;

  list.innerHTML = "";
  room.members.forEach((m, i) => {
    const badges = [];
    badges.push(room.doneIds.includes(m.id)
      ? { text: "done", cls: "badge--done" }
      : { text: "shooting…", cls: "badge--wait" });
    if (m.id === room.myId) badges.push({ text: "you", cls: "badge--you" });
    list.appendChild(makeMemberRow(m, i, badges));
  });
}

function renderLobbySettings() {
  const s = room.settings;
  if (!s) return;

  // Only the host can change things, and only until the booth has started.
  const editable = isHost() && !room.started;

  document.getElementById("lobby-shot-count").textContent = s.totalShots;
  document.getElementById("lobby-shot-minus").disabled = !editable || s.totalShots <= MIN_SHOTS;
  document.getElementById("lobby-shot-plus").disabled = !editable || s.totalShots >= MAX_SHOTS;

  document.querySelectorAll(".lobby-chip").forEach((chip) => {
    chip.classList.toggle("active", parseInt(chip.dataset.timer, 10) === s.timerSeconds);
    chip.disabled = !editable;
  });
  document.querySelectorAll(".lobby-swatch").forEach((sw) => {
    sw.classList.toggle("active", sw.dataset.template === s.template);
    sw.disabled = !editable;
  });

  document.getElementById("lobby-note").textContent = isHost()
    ? "You're the host: pick the settings, then press Start."
    : "Only the host can change these.";

  const startBtn = document.getElementById("btn-start-booth");


  // Add this helper function to your JS file
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input
        .replace(/<[^>]*>/g, '') // Strip ANY HTML tags (e.g., <script>)
        .replace(/[^\w\s\-']/g, '') // Optional: Only allow letters, numbers, spaces, hyphens, apostrophes
        .trim()
        .substring(0, 14); // Enforce the 14-character limit matching your backend NAME_MAX
}

// Example of how to use it when creating/joining a room:
const rawName = document.getElementById('nameInput').value;
const safeName = sanitizeInput(rawName);

// Now send 'safeName' to the server via socket.emit
socket.emit('create_room', { name: safeName });



async function uploadFinalSheet(canvasElement) {
    // 1. Get the base64 data from your canvas (this matches SHOT_MAGIC)
    const imageData = canvasElement.toDataURL('image/jpeg', 0.9);

    // 2. Show a loading state to the user
    console.log("Uploading secure photo...");

    try {
        const response = await fetch('/export_final_image', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ image_data: imageData })
        });

        const result = await response.json();

        if (response.ok) {
            console.log("Success! Image URL:", result.image_url);
            // TODO: Show the result.image_url to the user or trigger a download
            window.open(result.image_url, '_blank'); 
        } else {
            console.error("Upload failed:", result.error);
            alert("Sorry, there was an error saving your photo.");
        }
    } catch (error) {
        console.error("Network error:", error);
        alert("Network error. Please try again.");
    }
}