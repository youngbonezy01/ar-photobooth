import math
import os
import re
import secrets
import threading
import time
import uuid
import io
import base64

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, close_room, disconnect, emit
from flask_socketio import join_room as sio_join_room
from flask_socketio import leave_room as sio_leave_room
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
from PIL import Image
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
import cloudinary
import cloudinary.uploader
import cloudinary.api
from pyngrok import ngrok

# 1. Load environment variables from the .env file FIRST
load_dotenv()

# 2. Initialize the Flask app
app = Flask(__name__)

# 3. Set the Secret Key securely
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)

# 4. Initialize Flask-Limiter (rate limiting for HTTP routes)
limiter = Limiter(
    app=app,
    key_func=get_remote_address,  # Limits based on IP address
    default_limits=["200 per day", "50 per hour"]  # Global safety net
)

# Debug mode is OFF unless you turn it on
DEBUG = os.environ.get("PHOTOBOOTH_DEBUG") == "1"

# SocketIO setup
socketio = SocketIO(app, async_mode="threading", max_http_buffer_size=1_000_000)

# ---------------------------------------------------------------- settings
MAX_PEOPLE = 6
MAX_ROOMS = 200
ROOM_TTL_SECONDS = 60 * 60
NAME_MAX = 14
MAX_FAILED_JOINS = 8

MIN_SHOTS = 3
MAX_SHOTS = 6
ALLOWED_TIMERS = (3, 5, 10)
ALLOWED_TEMPLATES = ("cream", "pink", "red", "black")
START_DELAY_SECONDS = 3
READY_TIMEOUT_SECONDS = 25

STICKER_IDS = ("heart", "sparkle", "star", "flower", "bow", "cherry", "cloud", "cake")
MAX_STICKERS = 60

SHOT_HEADER = "data:image/jpeg;base64,"
SHOT_MAGIC = SHOT_HEADER + "/9j/"
MAX_SHOT_CHARS = 120_000
BASE64_BODY = re.compile(r"[A-Za-z0-9+/=]+")

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

DEFAULT_SETTINGS = {"totalShots": 4, "timerSeconds": 3, "template": "cream"}

# ------------------------------------------------------------------ memory
rooms = {}
sid_to_room = {}
failed_joins = {}
lock = threading.RLock()
_cleanup_started = False

# ----------------------------------------------------------------- helpers
def clean_name(raw, fallback="Guest"):
    name = str(raw or "")
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = re.sub(r"\s+", " ", name).strip()[:NAME_MAX]
    return name or fallback


def unique_name(room, name):
    taken = {m["name"].lower() for m in room["members"].values()}
    if name.lower() not in taken:
        return name
    n = 2
    while True:
        suffix = f" {n}"
        candidate = name[: NAME_MAX - len(suffix)] + suffix
        if candidate.lower() not in taken:
            return candidate
        n += 1


def normalize_code(raw):
    letters = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()
    if len(letters) != 8:
        return None
    return f"{letters[:4]}-{letters[4:]}"


def new_code():
    while True:
        raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        if code not in rooms:
            return code


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def valid_unit(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and 0 <= value <= 1
    )


def current_room(sid):
    return rooms.get(sid_to_room.get(sid))


def is_host(room, sid):
    member = room["members"].get(sid)
    return bool(member) and room["hostId"] == member["id"]


def valid_shots(shots, expected):
    if not isinstance(shots, list) or len(shots) != expected:
        return False
    for s in shots:
        if not isinstance(s, str) or len(s) > MAX_SHOT_CHARS:
            return False
        if not s.startswith(SHOT_MAGIC):
            return False
        if not BASE64_BODY.fullmatch(s[len(SHOT_HEADER):]):
            return False
    return True


def public_room(room):
    return {
        "code": room["code"],
        "hostId": room["hostId"],
        "started": room["started"],
        "settings": room["settings"],
        "members": [{"id": m["id"], "name": m["name"]} for m in room["members"].values()],
        "readyIds": list(room["ready"]),
        "doneIds": list(room["submissions"].keys()),
    }


def broadcast(room):
    room["lastActive"] = time.time()
    socketio.emit("room_update", public_room(room), to=room["code"])


def send_stickers(room):
    room["lastActive"] = time.time()
    socketio.emit("stickers_update", {"stickers": room["stickers"]}, to=room["code"])


# ----------------------------------------------- capture rounds + the sheet
def begin_capture(room):
    if room["begun"] or room["sheetSent"]:
        return
    room["begun"] = True
    room["lastActive"] = time.time()
    socketio.emit("begin_capture", {}, to=room["code"])

    s = room["settings"]
    seconds = s["totalShots"] * (s["timerSeconds"] + 3) + 30
    socketio.start_background_task(deadline_task, room, "collect", seconds)


def finalize_sheet(room):
    if room["sheetSent"]:
        return
    room["sheetSent"] = True
    room["lastActive"] = time.time()
    code = room["code"]

    people = [
        {"id": i, "name": room["submissions"][i]["name"], "shots": room["submissions"][i]["shots"]}
        for i in room["roster"]
        if i in room["submissions"]
    ]
    for person in people:
        socketio.emit("sheet_person", person, to=code)
    socketio.emit("sheet_done", {"count": len(people)}, to=code)


def maybe_advance(room):
    if not room["started"] or room["sheetSent"]:
        return
    member_ids = [m["id"] for m in room["members"].values()]
    if not member_ids:
        return
    if not room["begun"]:
        if all(i in room["ready"] for i in member_ids):
            begin_capture(room)
    else:
        if all(i in room["submissions"] for i in member_ids):
            finalize_sheet(room)


def deadline_task(room, kind, seconds):
    socketio.sleep(seconds)
    with lock:
        if rooms.get(room["code"]) is not room:
            return
        if kind == "ready" and room["started"] and not room["begun"]:
            begin_capture(room)
        elif kind == "collect" and room["begun"] and not room["sheetSent"]:
            finalize_sheet(room)


def remove_member(sid):
    with lock:
        code = sid_to_room.pop(sid, None)
        room = rooms.get(code)
        if not room:
            return
        member = room["members"].pop(sid, None)
        try:
            sio_leave_room(code, sid=sid)
        except Exception:
            pass
        if not room["members"]:
            del rooms[code]
            return
        if member and room["hostId"] == member["id"]:
            room["hostId"] = next(iter(room["members"].values()))["id"]
        broadcast(room)
        maybe_advance(room)


def cleanup_loop():
    while True:
        socketio.sleep(60)
        now = time.time()
        with lock:
            expired = [c for c, r in rooms.items() if now - r["lastActive"] > ROOM_TTL_SECONDS]
            for code in expired:
                room = rooms.pop(code)
                for sid in room["members"]:
                    sid_to_room.pop(sid, None)
                socketio.emit("room_closed", {"reason": "expired"}, to=code)
                close_room(code)


def room_error(message):
    emit("room_error", {"message": message})


# ------------------------------------------------------------------ routes
@app.route("/")
def index():
    return render_template("index.html")


@app.after_request
def revalidate_files(response):
    # Only force re-validation for the main HTML page
    if request.path == "/":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    # Let the browser cache static files (CSS/JS/Images) for 1 hour
    elif request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "public, max-age=3600"
    return response

# ------------------------------------------------------------ socket events
@socketio.on("connect")
def on_connect():
    global _cleanup_started
    with lock:
        failed_joins[request.sid] = 0
        if not _cleanup_started:
            _cleanup_started = True
            socketio.start_background_task(cleanup_loop)


@socketio.on("disconnect")
def on_disconnect():
    remove_member(request.sid)
    failed_joins.pop(request.sid, None)


@socketio.on("create_room")
def on_create_room(data=None):
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    
    # RATE LIMIT: Only allow 1 room creation per 60 seconds per socket
    with lock:
        now = time.time()
        last_create = failed_joins.get(f"{sid}_last_create", 0)
        if now - last_create < 60:
            room_error("Please wait before creating another room.")
            return
        failed_joins[f"{sid}_last_create"] = now
    
    with lock:
        if sid in sid_to_room:
            remove_member(sid)
        if len(rooms) >= MAX_ROOMS:
            room_error("The booths are all busy right now. Try again in a bit.")
            return

        code = new_code()
        member = {"id": secrets.token_hex(4), "name": clean_name(data.get("name"))}
        room = {
            "code": code,
            "hostId": member["id"],
            "started": False,
            "settings": dict(DEFAULT_SETTINGS),
            "members": {sid: member},
            "createdAt": time.time(),
            "lastActive": time.time(),
            "begun": False,
            "sheetSent": False,
            "roster": [],
            "ready": set(),
            "submissions": {},
            "stickers": [],
        }
        rooms[code] = room
        sid_to_room[sid] = code
        sio_join_room(code)

        emit("joined", {"code": code, "myId": member["id"]})
        broadcast(room)


@socketio.on("join_room")
def on_join_room(data=None):
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    code = normalize_code(data.get("code"))

    with lock:
        room = rooms.get(code) if code else None

        if not room:
            failed_joins[sid] = failed_joins.get(sid, 0) + 1
            if failed_joins[sid] >= MAX_FAILED_JOINS:
                room_error("Too many wrong codes. Refresh the page to try again.")
                disconnect()
                return
            room_error("That code doesn't match any booth.")
            return

        if sid_to_room.get(sid) == code:
            return
        if sid in sid_to_room:
            remove_member(sid)
        if room["started"]:
            room_error("That booth has already started.")
            return
        if len(room["members"]) >= MAX_PEOPLE:
            room_error(f"That booth is full ({MAX_PEOPLE} people).")
            return

        name = unique_name(room, clean_name(data.get("name")))
        member = {"id": secrets.token_hex(4), "name": name}
        room["members"][sid] = member
        sid_to_room[sid] = code
        sio_join_room(code)

        emit("joined", {"code": code, "myId": member["id"]})
        broadcast(room)


@socketio.on("leave_room")
def on_leave_room():
    remove_member(request.sid)
    emit("left", {})


@socketio.on("update_settings")
def on_update_settings(data=None):
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    with lock:
        room = current_room(sid)
        if not room:
            return
        if not is_host(room, sid):
            room_error("Only the host can change the booth settings.")
            return
        if room["started"]:
            room_error("The booth has already started.")
            return

        settings = room["settings"]

        shots = data.get("totalShots")
        if is_int(shots) and MIN_SHOTS <= shots <= MAX_SHOTS:
            settings["totalShots"] = shots

        timer = data.get("timerSeconds")
        if is_int(timer) and timer in ALLOWED_TIMERS:
            settings["timerSeconds"] = timer

        template = data.get("template")
        if isinstance(template, str) and template in ALLOWED_TEMPLATES:
            settings["template"] = template

        broadcast(room)


@socketio.on("start_booth")
def on_start_booth():
    sid = request.sid
    with lock:
        room = current_room(sid)
        if not room:
            return
        if not is_host(room, sid):
            room_error("Only the host can start the booth.")
            return
        if room["started"]:
            return

        room["started"] = True
        room["roster"] = [m["id"] for m in room["members"].values()]
        room["ready"] = set()
        room["submissions"] = {}
        broadcast(room)
        socketio.emit(
            "booth_started",
            {"settings": dict(room["settings"]), "startIn": START_DELAY_SECONDS},
            to=room["code"],
        )
        socketio.start_background_task(
            deadline_task, room, "ready", START_DELAY_SECONDS + READY_TIMEOUT_SECONDS
        )


@socketio.on("ready")
def on_ready():
    sid = request.sid
    with lock:
        room = current_room(sid)
        if not room or not room["started"] or room["begun"]:
            return
        member = room["members"].get(sid)
        if not member:
            return
        room["ready"].add(member["id"])
        broadcast(room)
        maybe_advance(room)


@socketio.on("submit_shots")
def on_submit_shots(data=None):
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    
    # RATE LIMIT: Only allow 1 submission per 10 seconds per socket
    with lock:
        now = time.time()
        last_submit = failed_joins.get(f"{sid}_last_submit", 0)
        if now - last_submit < 10:
            room_error("Please wait before submitting again.")
            return
        failed_joins[f"{sid}_last_submit"] = now
    
    with lock:
        room = current_room(sid)
        if not room or not room["started"] or not room["begun"]:
            return
        member = room["members"].get(sid)
        if not member:
            return
        if room["sheetSent"]:
            room_error("Too late: the sheet was already made without your photos.")
            return
        if member["id"] in room["submissions"]:
            return

        shots = data.get("shots")
        if not valid_shots(shots, room["settings"]["totalShots"]):
            room_error("Your photos couldn't be uploaded.")
            return

        room["submissions"][member["id"]] = {"name": member["name"], "shots": shots}
        broadcast(room)
        maybe_advance(room)


@socketio.on("add_sticker")
def on_add_sticker(data=None):
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    
    # RATE LIMIT: Only allow 1 sticker per second per socket
    with lock:
        now = time.time()
        last_sticker = failed_joins.get(f"{sid}_last_sticker", 0)
        if now - last_sticker < 1:
            return  # Silently ignore (no error message to avoid spam)
        failed_joins[f"{sid}_last_sticker"] = now
    
    with lock:
        room = current_room(sid)
        if not room or not room["sheetSent"]:
            return
        if len(room["stickers"]) >= MAX_STICKERS:
            return

        sticker_id = data.get("id")
        x, y = data.get("xPct"), data.get("yPct")
        if sticker_id not in STICKER_IDS or not valid_unit(x) or not valid_unit(y):
            return

        room["stickers"].append({
            "uid": secrets.token_hex(4),
            "id": sticker_id,
            "xPct": round(float(x), 4),
            "yPct": round(float(y), 4),
        })
        send_stickers(room)


@socketio.on("remove_sticker")
def on_remove_sticker(data=None):
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    with lock:
        room = current_room(sid)
        if not room or not room["sheetSent"]:
            return
        uid = data.get("uid")
        if not isinstance(uid, str):
            return
        before = len(room["stickers"])
        room["stickers"] = [s for s in room["stickers"] if s["uid"] != uid]
        if len(room["stickers"]) != before:
            send_stickers(room)


@app.route('/export_final_image', methods=['POST'])
@limiter.limit("3 per minute")  # RATE LIMIT: Only 3 exports per minute per IP
def export_final_image():
    payload = request.get_json(silent=True) or {}
    data = payload.get('image_data')
    
    if not data:
        return jsonify({"error": "No image data provided"}), 400
    
    if not isinstance(data, str) or not data.startswith(SHOT_MAGIC):
        return jsonify({"error": "Invalid image format"}), 400
    
    if len(data) > MAX_SHOT_CHARS * 3: 
        return jsonify({"error": "Image too large"}), 400

    try:
        header, encoded = data.split(",", 1)
        raw_bytes = base64.b64decode(encoded)
        img = Image.open(io.BytesIO(raw_bytes))
        img.verify() 
    except Exception:
        return jsonify({"error": "Corrupted or invalid image data"}), 400

    cloudinary.config(
        cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
        api_key=os.getenv("CLOUDINARY_API_KEY"),
        api_secret=os.getenv("CLOUDINARY_API_SECRET"),
        secure=True
    )

    try:
        public_id = f"photobooth_sheets/{uuid.uuid4().hex}"
        upload_result = cloudinary.uploader.upload(
            raw_bytes,
            public_id=public_id,
            folder="photobooth_sheets",
            resource_type="image",
            transformation=[{"quality": "auto:good", "fetch_format": "auto"}]
        )
        
        return jsonify({
            "status": "success",
            "image_url": upload_result['secure_url']
        })
        
    except Exception as e:
        print(f"Cloudinary Upload Error: {e}")
        return jsonify({"error": "Failed to upload image to server"}), 500


if __name__ == "__main__":
    print(" * Starting ngrok tunnel...")
    public_url = ngrok.connect(5000)
    print(f" * Ngrok Tunnel URL: {public_url}")
    print(" * Copy the URL above and open it on your phone!")
    print("-" * 50)
    
    socketio.run(app, debug=DEBUG, allow_unsafe_werkzeug=True)