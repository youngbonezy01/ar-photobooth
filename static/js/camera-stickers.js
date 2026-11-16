/* camera-stickers.js - user-uploaded stickers for the AR photobooth
 *
 * Features
 *  - Upload a sticker from the device gallery (stays in the browser, nothing is sent to Flask)
 *  - Choose where it appears: forehead, above head, eyes, nose, cheeks, fingertip, palm, or free on screen
 *  - Drag on the camera to move it, pinch to resize + rotate
 *  - Optional "Remove background" (MediaPipe selfie segmenter, best for photos of people)
 *  - Stickers + placements are saved in IndexedDB, so they are still there next visit
 *
 * Usage (see the bottom of this file for a copy-paste example)
 */

const DB_NAME = 'photobooth-stickers';
const STORE = 'stickers';
const MAX_SIDE = 1024;
const VISION_VERSION = '0.10.14';
const VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const SEGMENTER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

/* scale = sticker width as a fraction of the reference size
 * (face width for face anchors, palm width for hand anchors, canvas width for free) */
export const ANCHORS = {
  forehead:      { label: 'Forehead',              kind: 'face', scale: 0.6 },
  'above-head':  { label: 'Above the head',        kind: 'face', scale: 0.9 },
  eyes:          { label: 'Over the eyes',         kind: 'face', scale: 1.0 },
  nose:          { label: 'Nose',                  kind: 'face', scale: 0.3 },
  'cheek-left':  { label: 'Left cheek',            kind: 'face', scale: 0.3 },
  'cheek-right': { label: 'Right cheek',           kind: 'face', scale: 0.3 },
  'hand-index':  { label: 'Fingertip',             kind: 'hand', scale: 0.9 },
  'hand-palm':   { label: 'Palm',                  kind: 'hand', scale: 1.6 },
  free:          { label: 'Free (stays on screen)', kind: 'free', scale: 0.25 },
};

/* ---------- IndexedDB helpers ---------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ---------- small helpers ---------- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`);

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type)
  );
}

/* Downscale big gallery photos so they stay light in memory and IndexedDB */
async function normalizeImage(fileOrBlob) {
  const src = await createImageBitmap(fileOrBlob);
  const ratio = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * ratio));
  const h = Math.max(1, Math.round(src.height * ratio));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  src.close?.();
  const blob = await canvasToBlob(c, 'image/png');
  const bitmap = await createImageBitmap(blob);
  return { blob, bitmap };
}

/* ---------- geometry: where does a sticker go for a given anchor? ---------- */

function resolveTarget(anchorKey, lm, w, h, flipX, screenMirrored) {
  const P = (i) => ({ x: (flipX ? 1 - lm[i].x : lm[i].x) * w, y: lm[i].y * h });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const kind = ANCHORS[anchorKey].kind;

  if (kind === 'face') {
    // eye outer corners give head tilt; 234 / 454 are the face edges (width)
    let l = P(33);
    let r = P(263);
    if (r.x < l.x) [l, r] = [r, l];
    const angle = Math.atan2(r.y - l.y, r.x - l.x);
    const ref = dist(P(234), P(454));
    const up = { x: Math.sin(angle), y: -Math.cos(angle) };
    const shift = (p, k) => ({ x: p.x + up.x * ref * k, y: p.y + up.y * ref * k });

    let p;
    switch (anchorKey) {
      case 'forehead':
        p = shift(P(10), 0.1);
        break;
      case 'above-head':
        p = shift(P(10), 0.65);
        break;
      case 'eyes':
        p = mid(l, r);
        break;
      case 'nose':
        p = P(1);
        break;
      case 'cheek-left':
      case 'cheek-right': {
        let a = P(205);
        let b = P(425);
        if ((a.x > b.x) !== !!screenMirrored) [a, b] = [b, a]; // a = left as seen on screen
        p = anchorKey === 'cheek-left' ? a : b;
        break;
      }
      default:
        p = P(1);
    }
    return { x: p.x, y: p.y, ref, angle };
  }

  // hand
  const wrist = P(0);
  const middleBase = P(9);
  const angle = Math.atan2(middleBase.y - wrist.y, middleBase.x - wrist.x) + Math.PI / 2;
  const ref = dist(P(5), P(17)); // palm width
  const p = anchorKey === 'hand-index' ? P(8) : mid(wrist, middleBase);
  return { x: p.x, y: p.y, ref, angle };
}

function drawSticker(ctx, bitmap, cx, cy, width, angle) {
  const height = (width * bitmap.height) / bitmap.width;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/* ---------- UI ---------- */

const CSS = `
.sticker-dock{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:50;width:min(96vw,520px);
  font:14px system-ui,sans-serif;color:#fff}
.sticker-dock *{box-sizing:border-box}
.sd-tray{display:flex;align-items:center;gap:8px;background:rgba(20,20,30,.78);backdrop-filter:blur(8px);
  padding:8px;border-radius:14px}
.sd-add{flex:none;border:0;border-radius:10px;padding:10px 12px;background:#ff5fa2;color:#fff;font-weight:600;cursor:pointer}
.sd-list{display:flex;gap:8px;overflow-x:auto;flex:1;padding:2px}
.sd-item{position:relative;flex:none;width:52px;height:52px;border-radius:10px;background:rgba(255,255,255,.12);
  border:2px solid transparent;cursor:pointer}
.sd-item.on{border-color:#ff5fa2}
.sd-item img{width:100%;height:100%;object-fit:contain;border-radius:8px;pointer-events:none}
.sd-item button{position:absolute;width:20px;height:20px;border:0;border-radius:50%;background:#222;color:#fff;
  font-size:11px;line-height:20px;padding:0;cursor:pointer}
.sd-edit{top:-6px;left:-6px}
.sd-del{top:-6px;right:-6px}
.sd-editor{margin-top:8px;background:rgba(20,20,30,.88);backdrop-filter:blur(8px);padding:12px;border-radius:14px}
.sd-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.sd-row label{width:56px;flex:none}
.sd-row select,.sd-row input[type=range]{flex:1;min-width:0}
.sd-row select{padding:6px;border-radius:8px}
.sd-hint{font-size:12px;opacity:.8}
.sd-actions{display:flex;gap:8px;margin-bottom:0}
.sd-actions button{flex:1;border:0;border-radius:10px;padding:10px;font-weight:600;cursor:pointer}
.sd-bg{background:#3a3a4c;color:#fff}
.sd-done{background:#ff5fa2;color:#fff}
.sd-status{font-size:12px;margin-top:8px;min-height:1em;opacity:.9}
.sticker-dock--inline{position:static;left:auto;bottom:auto;transform:none;width:100%;margin-top:8px;font:inherit;color:#5b4a4a}
.sticker-dock--inline .sd-tray{background:transparent;backdrop-filter:none;padding:0}
.sticker-dock--inline .sd-add{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#d9829f,#b8527a);
  color:#fff;border:0;border-radius:999px;padding:6px 14px 6px 6px;font:inherit;font-size:.85em;font-weight:700;
  box-shadow:0 3px 10px rgba(184,82,122,.35);transition:transform .15s ease,box-shadow .15s ease}
.sticker-dock--inline .sd-add .sd-plus{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;
  background:rgba(255,255,255,.3);font-weight:800;line-height:1;transition:transform .25s ease}
.sticker-dock--inline .sd-add:hover{transform:translateY(-1px);box-shadow:0 5px 14px rgba(184,82,122,.45)}
.sticker-dock--inline .sd-add:hover .sd-plus{transform:rotate(90deg)}
.sticker-dock--inline .sd-add:active{transform:scale(.95)}
.sticker-dock--inline .sd-item{background:rgba(0,0,0,.05);width:44px;height:44px}
.sticker-dock--inline .sd-item button{background:#6b5a58}
.sticker-dock--inline .sd-editor{background:#fdfbf8;color:#5b4a4a;border:1px solid rgba(0,0,0,.08);
  box-shadow:0 6px 18px rgba(0,0,0,.06);backdrop-filter:none}
.sticker-dock--inline .sd-row input[type=range]{accent-color:#b8527a}
.sticker-dock--inline .sd-bg{background:#efe6e0;color:#6b5a58}
.sticker-dock--inline .sd-done{background:linear-gradient(135deg,#b8527a,#7d1f2e);color:#fff}
`;

/* ---------- the manager ---------- */

export class StickerManager {
  /**
   * @param {object}  opts
   * @param {HTMLCanvasElement} opts.canvas  the canvas your AR loop draws on (also used for drag/pinch)
   * @param {boolean} [opts.flipLandmarksX=true]  true if the preview is mirrored (selfie view)
   * @param {boolean} [opts.flipPointerX=false]   true ONLY if you mirror the canvas with CSS scaleX(-1)
   * @param {HTMLElement} [opts.mount=document.body]
   * @param {boolean} [opts.inline=false]  true = sits in the page layout (inside mount) instead of floating
   */
  constructor({ canvas, flipLandmarksX = true, flipPointerX = false, mount = document.body, inline = false }) {
    this.canvas = canvas;
    this.flipLandmarksX = flipLandmarksX;
    this.flipPointerX = flipPointerX;
    this.mount = mount;
    this.inline = inline;

    this.items = [];
    this.editingId = null;
    this.db = null;
    this._segmenter = null;
    this._lastRef = 200;
    this.pointers = new Map();
    this._gesture = null;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  async init() {
    try {
      this.db = await openDB();
      const rows = (await dbTx(this.db, 'readonly', (s) => s.getAll())) || [];
      for (const row of rows) {
        row.bitmap = await createImageBitmap(row.blob);
        this.items.push(row);
      }
    } catch (err) {
      console.warn('Sticker storage unavailable, stickers will not be saved:', err);
    }
    this._buildUI();
    this._renderList();
  }

  /* Lets your AR loop skip face/hand detection when no sticker needs it */
  needsFace() {
    return this.items.some((r) => r.enabled && ANCHORS[r.placement.anchor]?.kind === 'face');
  }

  needsHands() {
    return this.items.some((r) => r.enabled && ANCHORS[r.placement.anchor]?.kind === 'hand');
  }

  /* Call when your AR loop switches to a different canvas (start screen -> capture screen) */
  setCanvas(canvas) {
    if (canvas === this.canvas) return;
    if (this.editingId) this._stopEditing(); // the editor belongs to the screen it was opened on
    this.canvas = canvas;
  }

  /* Call this once per frame, AFTER you draw the video and before captureFrame() reads the canvas.
   * faces = faceLandmarker result .faceLandmarks, hands = handLandmarker result .landmarks */
  draw(ctx, faces = [], hands = []) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    for (const rec of this.items) {
      if (!rec.enabled || !rec.bitmap) continue;
      const pl = rec.placement;
      const anchor = ANCHORS[pl.anchor];
      if (!anchor) continue;

      const targets = [];
      if (anchor.kind === 'face') {
        for (const lm of faces) targets.push(resolveTarget(pl.anchor, lm, w, h, this.flipLandmarksX, this.flipPointerX));
      } else if (anchor.kind === 'hand') {
        for (const lm of hands) targets.push(resolveTarget(pl.anchor, lm, w, h, this.flipLandmarksX, this.flipPointerX));
      } else {
        targets.push({ x: pl.x * w, y: pl.y * h, ref: w, angle: 0 });
      }

      for (const t of targets) {
        const width = t.ref * pl.scale;
        const cx = t.x + pl.offX * t.ref;
        const cy = t.y + pl.offY * t.ref;
        drawSticker(ctx, rec.bitmap, cx, cy, width, t.angle + pl.rot);
        if (rec.id === this.editingId && anchor.kind !== 'free') this._lastRef = t.ref;
      }
    }
  }

  /* ----- UI building ----- */

  _buildUI() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'sticker-dock' + (this.inline ? ' sticker-dock--inline' : '');
    root.innerHTML = `
      <div class="sd-tray">
        <button class="sd-add" type="button"><span class="sd-plus">+</span>Sticker</button>
        <div class="sd-list"></div>
      </div>
      <div class="sd-editor" hidden>
        <div class="sd-row"><label>Where</label><select class="sd-anchor"></select></div>
        <div class="sd-row"><label>Size</label><input class="sd-scale" type="range" min="0.1" max="3" step="0.01"></div>
        <div class="sd-row"><label>Rotate</label><input class="sd-rot" type="range" min="-180" max="180" step="1"></div>
        <div class="sd-row sd-hint">Drag on the camera to move it. Pinch to resize and rotate. Face and hand spots need a face or hand in view to preview.</div>
        <div class="sd-row sd-actions">
          <button class="sd-bg" type="button">Remove background</button>
          <button class="sd-done" type="button">Done</button>
        </div>
        <div class="sd-status" aria-live="polite"></div>
      </div>
      <input class="sd-file" type="file" accept="image/*" hidden>`;
    this.mount.appendChild(root);

    const q = (sel) => root.querySelector(sel);
    this.ui = {
      root,
      list: q('.sd-list'),
      editor: q('.sd-editor'),
      anchor: q('.sd-anchor'),
      scale: q('.sd-scale'),
      rot: q('.sd-rot'),
      status: q('.sd-status'),
      file: q('.sd-file'),
    };

    for (const [key, a] of Object.entries(ANCHORS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = a.label;
      this.ui.anchor.appendChild(opt);
    }

    q('.sd-add').addEventListener('click', () => this.ui.file.click());
    this.ui.file.addEventListener('change', () => this._onFilePicked());
    q('.sd-done').addEventListener('click', () => this._stopEditing());
    q('.sd-bg').addEventListener('click', () => this._removeBackground());

    this.ui.anchor.addEventListener('change', () => {
      const rec = this._editing();
      if (!rec) return;
      const key = this.ui.anchor.value;
      rec.placement.anchor = key;
      rec.placement.scale = ANCHORS[key].scale; // sensible starting size for the new spot
      rec.placement.offX = 0;
      rec.placement.offY = 0;
      this._syncControls();
      this._save(rec);
    });
    this.ui.scale.addEventListener('input', () => {
      const rec = this._editing();
      if (rec) rec.placement.scale = parseFloat(this.ui.scale.value);
    });
    this.ui.rot.addEventListener('input', () => {
      const rec = this._editing();
      if (rec) rec.placement.rot = (parseFloat(this.ui.rot.value) * Math.PI) / 180;
    });
    this.ui.scale.addEventListener('change', () => this._saveEditing());
    this.ui.rot.addEventListener('change', () => this._saveEditing());
  }

  _renderList() {
    this.ui.list.innerHTML = '';
    for (const rec of this.items) {
      if (rec.thumbURL) URL.revokeObjectURL(rec.thumbURL);
      rec.thumbURL = URL.createObjectURL(rec.blob);

      const el = document.createElement('div');
      el.className = 'sd-item' + (rec.enabled ? ' on' : '');
      el.title = 'Tap to turn on or off';
      el.innerHTML = `<img alt="sticker"><button class="sd-edit" type="button" title="Edit">&#9998;</button><button class="sd-del" type="button" title="Delete">&times;</button>`;
      el.querySelector('img').src = rec.thumbURL;

      el.addEventListener('click', () => {
        rec.enabled = !rec.enabled;
        this._save(rec);
        this._renderList();
      });
      el.querySelector('.sd-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        rec.enabled = true;
        this._save(rec);
        this._renderList();
        this._startEditing(rec.id);
      });
      el.querySelector('.sd-del').addEventListener('click', (e) => {
        e.stopPropagation();
        this._delete(rec.id);
      });
      this.ui.list.appendChild(el);
    }
  }

  /* ----- adding stickers ----- */

  async _onFilePicked() {
    const file = this.ui.file.files && this.ui.file.files[0];
    this.ui.file.value = '';
    if (!file) return;
    try {
      const { blob, bitmap } = await normalizeImage(file);
      const rec = {
        id: newId(),
        name: file.name || 'sticker',
        blob,
        bitmap,
        enabled: true,
        placement: { anchor: 'above-head', scale: ANCHORS['above-head'].scale, offX: 0, offY: 0, rot: 0, x: 0.5, y: 0.5 },
      };
      this.items.push(rec);
      await this._save(rec);
      this._renderList();
      this._startEditing(rec.id);
    } catch (err) {
      console.error(err);
      this._status('Could not read that image. Try a different file.');
    }
  }

  async _delete(id) {
    const i = this.items.findIndex((r) => r.id === id);
    if (i < 0) return;
    const [rec] = this.items.splice(i, 1);
    if (rec.thumbURL) URL.revokeObjectURL(rec.thumbURL);
    rec.bitmap?.close?.();
    if (this.editingId === id) this._stopEditing();
    if (this.db) {
      try {
        await dbTx(this.db, 'readwrite', (s) => s.delete(id));
      } catch (err) {
        console.warn(err);
      }
    }
    this._renderList();
  }

  async _save(rec) {
    if (!this.db) return;
    const { bitmap, thumbURL, ...plain } = rec; // bitmap + thumbURL are runtime-only
    try {
      await dbTx(this.db, 'readwrite', (s) => s.put(plain));
    } catch (err) {
      console.warn('Could not save sticker:', err);
    }
  }

  _saveEditing() {
    const rec = this._editing();
    if (rec) this._save(rec);
  }

  /* ----- editing: sliders + drag/pinch on the camera ----- */

  _editing() {
    return this.items.find((r) => r.id === this.editingId) || null;
  }

  _startEditing(id) {
    this.editingId = id;
    this.ui.editor.hidden = false;
    this._status('');
    this._syncControls();
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
  }

  _stopEditing() {
    this._saveEditing();
    this.editingId = null;
    this.pointers.clear();
    this._gesture = null;
    this.ui.editor.hidden = true;
    this.canvas.style.touchAction = '';
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
  }

  _syncControls() {
    const rec = this._editing();
    if (!rec) return;
    this.ui.anchor.value = rec.placement.anchor;
    this.ui.scale.value = rec.placement.scale;
    this.ui.rot.value = Math.round((rec.placement.rot * 180) / Math.PI);
  }

  _status(msg) {
    if (this.ui && this.ui.status) this.ui.status.textContent = msg;
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    let nx = (e.clientX - r.left) / r.width;
    if (this.flipPointerX) nx = 1 - nx;
    return { x: nx * this.canvas.width, y: ((e.clientY - r.top) / r.height) * this.canvas.height };
  }

  _pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, ang: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  _onDown(e) {
    if (!this._editing()) return;
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, this._pt(e));
    if (this.pointers.size === 2) {
      const rec = this._editing();
      this._gesture = { ...this._pinchState(), scale0: rec.placement.scale, rot0: rec.placement.rot };
    }
  }

  _onMove(e) {
    const rec = this._editing();
    if (!rec || !this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const cur = this._pt(e);
    this.pointers.set(e.pointerId, cur);
    const pl = rec.placement;

    if (this.pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (ANCHORS[pl.anchor].kind === 'free') {
        pl.x = clamp(pl.x + dx / this.canvas.width, 0, 1);
        pl.y = clamp(pl.y + dy / this.canvas.height, 0, 1);
      } else {
        pl.offX += dx / this._lastRef;
        pl.offY += dy / this._lastRef;
      }
    } else if (this.pointers.size === 2 && this._gesture) {
      const s = this._pinchState();
      pl.scale = clamp(this._gesture.scale0 * (s.dist / this._gesture.dist), 0.1, 3);
      let rot = this._gesture.rot0 + (s.ang - this._gesture.ang);
      while (rot > Math.PI) rot -= 2 * Math.PI;
      while (rot < -Math.PI) rot += 2 * Math.PI;
      pl.rot = rot;
      this._syncControls();
    }
  }

  _onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this._gesture = null;
    if (this.pointers.size === 0) this._saveEditing();
  }

  /* ----- background removal (MediaPipe selfie segmenter, works best on photos of people) ----- */

  async _getSegmenter() {
    if (this._segmenter) return this._segmenter;
    const vision = await import(`${VISION_CDN}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
    this._segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEGMENTER_MODEL },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    return this._segmenter;
  }

  async _removeBackground() {
    const rec = this._editing();
    if (!rec) return;
    this._status('Removing background... (the first time it downloads a small model)');
    try {
      const segmenter = await this._getSegmenter();
      const c = document.createElement('canvas');
      c.width = rec.bitmap.width;
      c.height = rec.bitmap.height;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(rec.bitmap, 0, 0);

      const result = segmenter.segment(c);
      const masks = result.confidenceMasks;
      const mask = masks[masks.length - 1];
      const data = mask.getAsFloat32Array();
      if (data.length !== c.width * c.height) throw new Error('Unexpected mask size');

      const img = cx.getImageData(0, 0, c.width, c.height);
      const px = img.data;
      let kept = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        const a = v <= 0.3 ? 0 : v >= 0.7 ? 1 : (v - 0.3) / 0.4; // soft edge
        if (a > 0.5) kept++;
        px[i * 4 + 3] = Math.round(px[i * 4 + 3] * a);
      }
      if (typeof result.close === 'function') result.close();
      else masks.forEach((m) => m.close());

      if (kept < data.length * 0.01) {
        this._status('Could not find a person in this photo, so it was left as it is.');
        return;
      }

      cx.putImageData(img, 0, 0);
      const blob = await canvasToBlob(c, 'image/png');
      const bitmap = await createImageBitmap(blob);
      rec.bitmap.close?.();
      rec.blob = blob;
      rec.bitmap = bitmap;
      await this._save(rec);
      this._renderList();
      this._status('Background removed.');
    } catch (err) {
      console.error(err);
      this._status('Background removal failed. You can still use the sticker as it is.');
    }
  }
}

/* ---------------------------------------------------------------------------
 * Copy-paste example for your AR loop
 *
 *   import { StickerManager } from '/static/js/camera-stickers.js';
 *
 *   const stickers = new StickerManager({
 *     canvas,                    // the canvas you draw the video + effects on
 *     flipLandmarksX: true,      // true if your preview is mirrored like a selfie camera
 *     flipPointerX: false,       // true only if the canvas is mirrored with CSS scaleX(-1)
 *   });
 *   await stickers.init();
 *
 *   // inside your requestAnimationFrame loop, after drawing the video and other effects:
 *   stickers.draw(ctx, faceResult?.faceLandmarks ?? [], handResult?.landmarks ?? []);
 * ------------------------------------------------------------------------- */