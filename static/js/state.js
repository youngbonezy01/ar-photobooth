// state.js — the single source of truth for everything the booth remembers.
// Loaded FIRST, before every other script.

const MAX_PEOPLE = 6;

const state = {
  // booth settings
  totalShots: 4,
  timerSeconds: 3,
  filterId: "original",
  template: "cream",

  // capture progress
  currentShotIndex: 0,

  // stickers placed on the finished strip
  stickers: [],            // [{ glyph, xPct, yPct }], positions are 0–1 of the whole strip
  activeStickerId: null,   // sticker currently selected in the picker

  // people in the booth. Solo = just one person.
  // Rooms will fill this with up to MAX_PEOPLE entries, one strip each.
  myId: "me",
  participants: [{ id: "me", name: "You", shots: [] }],
};

// The participant that is THIS device's user.
function me() {
  return state.participants.find((p) => p.id === state.myId);
}

// Back to a fresh solo session (keeps the settings the user picked).
function resetSession() {
  state.participants = [{ id: "me", name: "You", shots: [] }];
  state.myId = "me";
  state.stickers = [];
  state.currentShotIndex = 0;
}