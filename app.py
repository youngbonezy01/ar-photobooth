import math
import os
import re
import secrets
import threading
import time
import uuid

from flask import Flask, render_template, request
from flask_socketio import SocketIO, close_room, disconnect, emit
from flask_socketio import join_room as sio_join_room
from flask_socketio import leave_room as sio_leave_room
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

# 1. Load environment variables from the .env file FIRST
load_dotenv()

# 2. Initialize the Flask app
app = Flask(__name__)

# 3. Set the Secret Key securely (uses .env if available, otherwise generates a safe random one for local dev)
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)

# Debug mode is OFF unless you turn it on. Never leave it on while ngrok is open:
# the debugger would be reachable by anyone who has your link.
#   Debug on (local work only):   $env:PHOTOBOOTH_DEBUG="1"; python app.py
DEBUG = os.environ.get("PHOTOBOOTH_DEBUG") == "1"

# "threading" mode works on Windows without extra setup. simple-websocket gives
# real WebSockets; without it Socket.IO falls back to slower long-polling.
# max_http_buffer_size is the biggest single message allowed. One person's
# photos (up to 6 shrunken JPEGs) are well under 1 MB.
socketio = SocketIO(app, async_mode="threading", max_http_buffer_size=1_000_000)

# ---------------------------------------------------------------- settings
MAX_PEOPLE = 6
MAX_ROOMS = 200
ROOM_TTL_SECONDS = 60 * 60      # close rooms after an hour of no activity
NAME_MAX = 14                   # matches what the strip renderer prints
MAX_FAILED_JOINS = 8            # wrong codes allowed per connection

# What the host is allowed to choose (the server never trusts the browser)
MIN_SHOTS = 3
MAX_SHOTS = 6
ALLOWED_TIMERS = (3, 5, 10)
ALLOWED_TEMPLATES = ("cream", "pink", "red", "black")
START_DELAY_SECONDS = 3         # "Starting in 3…" so every device begins together
READY_TIMEOUT_SECONDS = 25      # how long to wait for every camera to open

# Stickers: the ids must match STICKERS in static/js/stickers.js
STICKER_IDS = ("heart", "sparkle", "star", "flower", "bow", "cherry", "cloud", "cake")
MAX_STICKERS = 60

# Uploaded photos must be small JPEG data URLs (JPEG files start with /9j/)
SHOT_HEADER = "data:image/jpeg;base64,"
SHOT_MAGIC = SHOT_HEADER + "/9j/"
MAX_SHOT_CHARS = 120_000
BASE64_BODY = re.compile(r"[A-Za-z0-9+/=]+")

# No 0/O, 1/I/L so codes are easy to read out loud
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

DEFAULT_SETTINGS = {"totalShots": 4, "timerSeconds": 3, "template": "cream"}

# ------------------------------------------------------------------ memory
# Everything lives in server memory: nothing is written to disk, and it all
# disappears when the server restarts or a room closes.
rooms = {}          # code -> room dict
sid_to_room = {}    # socket id -> room code
failed_joins = {}   # socket id -> number of wrong codes
lock = threading.RLock()
_cleanup_started = False

# ----------------------------------------------------------------- helpers
def clean_name(raw, fallback="Guest"):
    name = str(raw or "")
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)   # strip control characters
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
    # bool is a kind of int in Python, so True/False must be rejected explicitly
    return isinstance(value, int) and not isinstance(value, bool)


def valid_unit(value):
    """A real number from 0 to 1 (a position on the sheet)."""
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
    """Exactly `expected` small JPEG data URLs, nothing else."""
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
    """The only shape of a room that is ever sent to browsers."""
    return {
        "code": room["code"],
        "hostId": room["hostId"],
        "started": room["started"],
        "settings": room["settings"],
        "members": [{"id": m["id"], "name": m["name"]} for m in room["members"].values()],
        "readyIds": list(room["ready"]),               # whose camera is open
        "doneIds": list(room["submissions"].keys()),   # who has uploaded their photos
    }


def broadcast(room):
    room["lastActive"] = time.time()
    socketio.emit("room_update", public_room(room), to=room["code"])


def send_stickers(room):
    room["lastActive"] = time.time()
    socketio.emit("stickers_update", {"stickers": room["stickers"]}, to=room["code"])


# ----------------------------------------------- capture rounds + the sheet
def begin_capture(room):
    """Everyone's camera is up (or we ran out of patience): tell them to shoot."""
    if room["begun"] or room["sheetSent"]:
        return
    room["begun"] = True
    room["lastActive"] = time.time()
    socketio.emit("begin_capture", {}, to=room["code"])

    # Time limit for collecting photos: every shot's timer, plus slack
    s = room["settings"]
    seconds = s["totalShots"] * (s["timerSeconds"] + 3) + 30
    socketio.start_background_task(deadline_task, room, "collect", seconds)


def finalize_sheet(room):
    """Sends everyone's photos to the whole room, one person per message."""
    if room["sheetSent"]:
        return
    room["sheetSent"] = True
    room["lastActive"] = time.time()
    code = room["code"]

    # Roster order = join order. Anyone who never uploaded is left out.
    people = [
        {"id": i, "name": room["submissions"][i]["name"], "shots": room["submissions"][i]["shots"]}
        for i in room["roster"]
        if i in room["submissions"]
    ]
    for person in people:
        socketio.emit("sheet_person", person, to=code)
    socketio.emit("sheet_done", {"count": len(people)}, to=code)


def maybe_advance(room):
    """Moves the booth forward as soon as everyone still here has caught up."""
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
            return                      # room closed in the meantime
        if kind == "ready" and room["started"] and not room["begun"]:
            begin_capture(room)
        elif kind == "collect" and room["begun"] and not room["sheetSent"]:
            finalize_sheet(room)


def remove_member(sid):
    """Takes a socket out of its room. Hands over host, or closes an empty room."""
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
        maybe_advance(room)             # the person who left may have been the last one we waited for


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
    # Ask browsers to re-check the page and our JS/CSS every time, so a phone
    # can never get stuck running an old copy of the code.
    if request.path == "/" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
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
    with lock:
        if sid in sid_to_room:
            remove_member(sid)          # leave any room we were already in
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
            # filled in when the host presses Start
            "begun": False,             # shooting has begun
            "sheetSent": False,         # the finished sheet has gone out
            "roster": [],               # member ids at the moment of Start, in order
            "ready": set(),             # member ids whose camera is open
            "submissions": {},          # member id -> {"name", "shots"}
            "stickers": [],             # shared stickers on the finished sheet
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
            return                       # already in this room
        if sid in sid_to_room:
            remove_member(sid)           # switching rooms
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
    """Host changes shots / timer / strip style. Everyone gets the new values."""
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
    """Host presses Start: lock the room, tell everyone to get their camera ready."""
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
        # If somebody's camera never opens, begin without waiting forever
        socketio.start_background_task(
            deadline_task, room, "ready", START_DELAY_SECONDS + READY_TIMEOUT_SECONDS
        )


@socketio.on("ready")
def on_ready():
    """A device's camera is open. When all are ready, everyone shoots together."""
    sid = request.sid
    with lock:
        room = current_room(sid)
        if not room or not room["started"] or room["begun"]:
            return
        member = room["members"].get(sid)
        if not member:
            return
        room["ready"].add(member["id"])
        broadcast(room)                  # so everyone can see who we're still waiting for
        maybe_advance(room)


@socketio.on("submit_shots")
def on_submit_shots(data=None):
    """A device uploads its shrunken photos."""
    data = data if isinstance(data, dict) else {}
    sid = request.sid
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
            return                       # already uploaded

        shots = data.get("shots")
        if not valid_shots(shots, room["settings"]["totalShots"]):
            room_error("Your photos couldn't be uploaded.")
            return

        room["submissions"][member["id"]] = {"name": member["name"], "shots": shots}
        broadcast(room)                  # everyone's "x of y finished" list updates
        maybe_advance(room)


@socketio.on("add_sticker")
def on_add_sticker(data=None):
    """Anyone in the booth can put a sticker on the finished sheet."""
    data = data if isinstance(data, dict) else {}
    sid = request.sid
    with lock:
        room = current_room(sid)
        if not room or not room["sheetSent"]:
            return
        if len(room["stickers"]) >= MAX_STICKERS:
            return                       # the sheet is full, quietly ignore

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


if __name__ == "__main__":
    # Runs on 127.0.0.1 only. ngrok reaches it from your own machine.
    socketio.run(app, debug=DEBUG, allow_unsafe_werkzeug=True)