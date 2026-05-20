import io
import os
import time
import zipfile
from pathlib import Path

import jwt
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.middleware.sessions import SessionMiddleware

from . import auth, config, coder_client, db, storage, tokens
from .ws import hub
from .yjs import yjs_handler

app = FastAPI(title="ClubGenAI Classroom API", root_path="/classroom")
app.add_middleware(SessionMiddleware, secret_key=config.SESSION_SECRET, https_only=False, same_site="lax")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    db.init()


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── Auth: participant join ────────────────────────────────────────────────────

@app.post("/api/join")
def join_room(
    request: Request,
    display_name: str = Form(...),
    code: str = Form(...),
):
    display_name = display_name.strip()
    if not display_name or len(display_name) > 60:
        raise HTTPException(400, "Display name required (1–60 chars)")
    room = storage.get_room_by_code(code.strip().upper())
    if not room:
        raise HTTPException(404, "Room not found")
    if room["status"] == "closed":
        raise HTTPException(403, "Room is closed")
    if room.get("locked"):
        raise HTTPException(403, "Room is locked")

    enrolled = storage.list_enrollments(room["id"])
    if len(enrolled) >= room["max_participants"]:
        raise HTTPException(403, "Room is full")

    user = storage.create_participant(display_name)
    enr = storage.enroll_participant(user["id"], room["id"])
    storage.log_event(room["id"], "participant_joined", user["id"], {"display_name": display_name})

    request.session["participant_id"] = user["id"]
    request.session["participant_room_id"] = room["id"]
    request.session["enrollment_id"] = enr["id"]
    return {
        "user": user,
        "room_id": room["id"],
        "enrollment_id": enr["id"],
    }


@app.post("/api/admin/login")
def admin_login(request: Request, jwt_token: str = Form(...)):
    """Accept portal JWT, stash in session."""
    token = jwt_token.strip()
    try:
        payload = jwt.decode(
            token,
            config.MCP_JWT_SECRET,
            algorithms=[config.MCP_JWT_ALG],
            audience=config.MCP_JWT_AUDIENCE,
            issuer="sfeir-lab-portal",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid JWT: {e}")
    request.session["animator_token"] = token
    user = storage.upsert_animator(
        github_id=str(payload["sub"]),
        github_login=payload.get("github_login", ""),
        name=payload.get("name") or payload.get("github_login", ""),
    )
    return {"user": user}


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    """Return current session info, or 401."""
    pid = request.session.get("participant_id")
    if pid:
        user = storage.get_user(pid)
        return {"kind": "participant", "user": user, "room_id": request.session.get("participant_room_id")}
    token = request.session.get("animator_token")
    if token:
        try:
            payload = jwt.decode(
                token, config.MCP_JWT_SECRET, algorithms=[config.MCP_JWT_ALG],
                audience=config.MCP_JWT_AUDIENCE, issuer="sfeir-lab-portal",
                options={"require": ["exp", "sub"]},
            )
            user = storage.upsert_animator(
                github_id=str(payload["sub"]),
                github_login=payload.get("github_login", ""),
                name=payload.get("name") or payload.get("github_login", ""),
            )
            return {"kind": "animator", "user": user}
        except jwt.PyJWTError:
            request.session.clear()
    raise HTTPException(401, "Not authenticated")


# ── Participant API ───────────────────────────────────────────────────────────

@app.get("/api/rooms/{room_id}")
def participant_room_view(room_id: int, request: Request):
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403, "Wrong room for this session")
    room = storage.get_room(room_id)
    if not room:
        raise HTTPException(404)
    return {
        "room": room,
        "user": ctx["user"],
        "checklist": storage.list_checklist(room_id),
        "progress_ids": storage.list_progress(ctx["user"]["id"], room_id),
        "resources": storage.list_resources(room_id),
        "submissions": storage.list_submissions(room_id, ctx["user"]["id"]),
        "mcp_token": storage.get_mcp_token_for_enrollment(request.session.get("enrollment_id")),
        "timer": storage.get_timer(room_id),
    }


@app.post("/api/rooms/{room_id}/help")
async def request_help(
    room_id: int,
    request: Request,
    message: str = Form(""),
):
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403)
    last = storage.last_help_request_at(ctx["user"]["id"], room_id)
    if last and time.time() - last < config.HELP_REQUEST_COOLDOWN_SECONDS:
        raise HTTPException(429, "Wait a moment before requesting help again")
    hr = storage.create_help_request(ctx["user"]["id"], room_id, message)
    storage.log_event(room_id, "help_requested", ctx["user"]["id"], {"help_id": hr["id"]})
    await hub.broadcast(room_id, {"type": "help_requested", "help": hr, "by": ctx["user"]["display_name"]})
    return {"ok": True, "help_id": hr["id"]}


@app.post("/api/rooms/{room_id}/submit")
async def submit(
    room_id: int,
    request: Request,
    file: UploadFile = File(...),
):
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403)
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 10MB)")
    sub = storage.submit_file(ctx["user"]["id"], room_id, file.filename or "file.txt", data)
    storage.log_event(room_id, "submission", ctx["user"]["id"], {"filename": sub["filename"], "version": sub["version"]})
    await hub.broadcast(room_id, {"type": "submission", "user": ctx["user"]["display_name"], "filename": sub["filename"], "version": sub["version"]})
    return {"ok": True, "submission_id": sub["id"], "version": sub["version"]}


@app.post("/api/rooms/{room_id}/progress")
async def update_progress(
    room_id: int,
    request: Request,
    item_id: int = Form(...),
    done: bool = Form(...),
):
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403)
    storage.mark_progress(ctx["user"]["id"], room_id, item_id, done)
    storage.log_event(room_id, "progress", ctx["user"]["id"], {"item_id": item_id, "done": done})
    await hub.broadcast(room_id, {"type": "progress", "user_id": ctx["user"]["id"], "item_id": item_id, "done": done})
    return {"ok": True}


@app.get("/api/rooms/{room_id}/resources/{resource_id}/download")
def download_resource(room_id: int, resource_id: int, request: Request):
    auth.current_participant(request)
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM resource WHERE id=? AND room_id=?", (resource_id, room_id)).fetchone()
    if not row:
        raise HTTPException(404)
    return FileResponse(storage.resource_disk_path(dict(row)), filename=row["filename"])


# ── Animator API ──────────────────────────────────────────────────────────────

@app.get("/api/admin/rooms")
def admin_list_rooms(request: Request):
    ctx = auth.current_animator(request)
    return storage.list_animator_rooms(ctx["user"]["id"])


@app.post("/api/admin/rooms")
def create_room(
    request: Request,
    name: str = Form(...),
    subject: str = Form(""),
    max_participants: int = Form(50),
    checklist: str = Form(""),
):
    ctx = auth.current_animator(request)
    items = [l.strip() for l in checklist.splitlines() if l.strip()]
    room = storage.create_room(
        name=name.strip()[:120],
        subject=subject.strip()[:200],
        animator_id=ctx["user"]["id"],
        max_participants=min(max_participants, config.MAX_PARTICIPANTS_PER_ROOM),
        checklist=items,
    )
    storage.log_event(room["id"], "room_created", ctx["user"]["id"], None)
    return room


@app.get("/api/admin/rooms/{room_id}")
def admin_room_view(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    return {
        "room": storage.get_room(room_id),
        "animators": storage.room_animators(room_id),
        "enrollments": storage.list_enrollments(room_id),
        "help_requests": storage.list_help_requests(room_id),
        "submissions": storage.list_submissions(room_id),
        "resources": storage.list_resources(room_id),
        "checklist": storage.list_checklist(room_id),
        "progress_summary": storage.progress_summary(room_id),
        "stats": storage.room_stats(room_id),
        "timer": storage.get_timer(room_id),
    }


@app.put("/api/admin/rooms/{room_id}")
def update_room(
    room_id: int,
    request: Request,
    name: str = Form(None),
    subject: str = Form(None),
    max_participants: int = Form(None),
    checklist_items: str = Form(None),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    kwargs = {}
    if name is not None:
        kwargs["name"] = name.strip()[:120]
    if subject is not None:
        kwargs["subject"] = subject.strip()[:200]
    if max_participants is not None:
        kwargs["max_participants"] = min(max_participants, config.MAX_PARTICIPANTS_PER_ROOM)
    if checklist_items is not None:
        kwargs["checklist"] = [l.strip() for l in checklist_items.splitlines() if l.strip()]
    room = storage.update_room(room_id, **kwargs)
    storage.log_event(room_id, "room_updated", ctx["user"]["id"], None)
    return room


@app.post("/api/admin/rooms/{room_id}/lock")
async def admin_lock(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    room = storage.set_room_locked(room_id, True)
    storage.log_event(room_id, "room_locked", ctx["user"]["id"], None)
    await hub.broadcast(room_id, {"type": "room_locked"})
    return room


@app.post("/api/admin/rooms/{room_id}/unlock")
async def admin_unlock(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    room = storage.set_room_locked(room_id, False)
    storage.log_event(room_id, "room_unlocked", ctx["user"]["id"], None)
    await hub.broadcast(room_id, {"type": "room_unlocked"})
    return room


@app.post("/api/admin/rooms/{room_id}/start")
async def admin_start(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.start_room(room_id)
    storage.log_event(room_id, "room_started", ctx["user"]["id"], None)
    await hub.broadcast(room_id, {"type": "room_started"})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/close")
async def admin_close(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.close_room(room_id)
    storage.log_event(room_id, "room_closed", ctx["user"]["id"], None)
    await hub.broadcast(room_id, {"type": "room_closed"})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/animators")
def add_room_animator(
    room_id: int,
    request: Request,
    github_login: str = Form(...),
    github_id: str = Form(...),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    other = storage.upsert_animator(github_id=github_id, github_login=github_login, name=github_login)
    storage.add_animator(room_id, other["id"])
    storage.log_event(room_id, "animator_added", ctx["user"]["id"], {"added_id": other["id"]})
    return {"ok": True, "user_id": other["id"]}


@app.post("/api/admin/rooms/{room_id}/resources")
async def upload_resource(
    room_id: int,
    request: Request,
    file: UploadFile = File(...),
    is_starter: bool = Form(False),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413)
    res = storage.upload_resource(room_id, file.filename or "file.txt", data, ctx["user"]["id"], is_starter)
    storage.log_event(room_id, "resource_uploaded", ctx["user"]["id"], {"filename": res["filename"]})
    await hub.broadcast(room_id, {"type": "resource_added", "filename": res["filename"], "is_starter": is_starter})
    return res


@app.post("/api/admin/rooms/{room_id}/broadcast")
async def admin_broadcast(
    room_id: int,
    request: Request,
    message: str = Form(...),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    last = storage.last_broadcast_at(ctx["user"]["id"], room_id)
    if last and time.time() - last < config.BROADCAST_COOLDOWN_SECONDS:
        raise HTTPException(429)
    bm = storage.create_broadcast(room_id, ctx["user"]["id"], message)
    storage.log_event(room_id, "broadcast", ctx["user"]["id"], {"msg_id": bm["id"]})
    await hub.broadcast(room_id, {"type": "broadcast", "message": bm["message"], "from": ctx["user"]["display_name"], "sent_at": bm["sent_at"]})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/spotlight")
async def admin_spotlight(
    room_id: int,
    request: Request,
    target_user_id: int = Form(...),
    submission_id: int = Form(...),
    anonymous: bool = Form(False),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    with db.cursor() as conn:
        sub = conn.execute("SELECT * FROM submission WHERE id=? AND room_id=?", (submission_id, room_id)).fetchone()
    if not sub:
        raise HTTPException(404)
    excerpt = storage.submission_disk_path(dict(sub)).read_text(errors="replace")[:4000]
    ev = storage.create_spotlight(room_id, target_user_id, ctx["user"]["id"], anonymous, excerpt)
    storage.log_event(room_id, "spotlight", ctx["user"]["id"], {"target_user_id": target_user_id, "anonymous": anonymous})
    await hub.broadcast(room_id, {
        "type": "spotlight", "content": excerpt, "anonymous": anonymous,
        "by": ctx["user"]["display_name"], "filename": sub["filename"],
    })
    return {"ok": True, "spotlight_id": ev["id"]}


@app.post("/api/admin/rooms/{room_id}/timer")
async def admin_timer(
    room_id: int,
    request: Request,
    action: str = Form(...),
    duration_seconds: int = Form(0),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    if action == "set":
        t = storage.set_timer(room_id, duration_seconds)
    elif action == "start":
        t = storage.start_timer(room_id)
    elif action == "pause":
        t = storage.pause_timer(room_id)
    else:
        raise HTTPException(400, "Unknown action")
    storage.log_event(room_id, f"timer_{action}", ctx["user"]["id"], t)
    await hub.broadcast(room_id, {"type": "timer", "timer": t})
    return {"ok": True, "timer": t}


@app.post("/api/admin/rooms/{room_id}/help/{help_id}/claim")
async def admin_claim_help(room_id: int, help_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.claim_help_request(help_id, ctx["user"]["id"])
    await hub.broadcast(room_id, {"type": "help_claimed", "help_id": help_id, "animator": ctx["user"]["display_name"]})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/help/{help_id}/resolve")
async def admin_resolve_help(room_id: int, help_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.resolve_help_request(help_id)
    await hub.broadcast(room_id, {"type": "help_resolved", "help_id": help_id})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/help/{help_id}/note")
def admin_help_note(
    room_id: int,
    help_id: int,
    request: Request,
    content: str = Form(...),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    note = storage.add_help_note(help_id, ctx["user"]["id"], content)
    return {"ok": True, "note_id": note["id"]}


@app.post("/api/admin/rooms/{room_id}/tokens/{enrollment_id}/activate")
def admin_activate_token(
    room_id: int,
    enrollment_id: int,
    request: Request,
    ttl_seconds: int = Form(3 * 3600),
):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    enr = storage.get_enrollment(enrollment_id)
    if not enr or enr["room_id"] != room_id:
        raise HTTPException(404)
    raw, _ = tokens.issue_participant_token(
        enrollment_id=enrollment_id,
        user_id=enr["user_id"],
        room_id=room_id,
        ttl_seconds=ttl_seconds,
    )
    storage.log_event(room_id, "mcp_token_issued", ctx["user"]["id"], {"enrollment_id": enrollment_id})
    return {"ok": True, "token": raw}


@app.post("/api/admin/rooms/{room_id}/tokens/{enrollment_id}/revoke")
def admin_revoke_token(room_id: int, enrollment_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.revoke_mcp_token(enrollment_id)
    return {"ok": True}


@app.get("/api/admin/rooms/{room_id}/submissions/{submission_id}/download")
def admin_download_submission(room_id: int, submission_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM submission WHERE id=? AND room_id=?", (submission_id, room_id)).fetchone()
    if not row:
        raise HTTPException(404)
    return FileResponse(storage.submission_disk_path(dict(row)), filename=f"{row['filename']}.v{row['version']}")


@app.get("/api/admin/rooms/{room_id}/participants/{enrollment_id}/diff")
def admin_participant_diff(room_id: int, enrollment_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    return storage.get_participant_diff(room_id, enrollment_id)


@app.post("/api/admin/rooms/{room_id}/solution")
async def admin_set_solution(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    body = await request.json()
    code = body.get("code", "")
    storage.set_room_solution(room_id, code)
    return {"ok": True}


@app.get("/api/admin/rooms/{room_id}/report")
def admin_report(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    report = storage.room_report(room_id)
    if not report:
        raise HTTPException(404)
    return report


@app.get("/api/admin/rooms/{room_id}/export")
def admin_export(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    subs = storage.list_submissions(room_id)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for s in subs:
            p = storage.submission_disk_path(s)
            if p.exists():
                z.write(p, f"{s['display_name']}/{s['filename']}.v{s['version']}")
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="room-{room_id}-submissions.zip"'},
    )


@app.get("/api/admin/rooms/{room_id}/events")
def admin_events(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    return storage.list_events(room_id)


# ── Templates ─────────────────────────────────────────────────────────────────

@app.get("/api/admin/templates")
def list_templates(request: Request):
    ctx = auth.current_animator(request)
    return storage.list_templates(ctx["user"]["id"])


@app.post("/api/admin/templates")
async def create_template(request: Request):
    ctx = auth.current_animator(request)
    body = await request.json()
    name = str(body.get("name", "")).strip()[:120]
    if not name:
        raise HTTPException(400, "name required")
    subject = str(body.get("subject", "")).strip()[:200]
    max_participants = min(int(body.get("max_participants", 50)), config.MAX_PARTICIPANTS_PER_ROOM)
    raw_items = body.get("checklist_items", [])
    items = [str(i).strip()[:200] for i in raw_items if str(i).strip()]
    tpl = storage.create_template(
        name=name,
        animator_id=ctx["user"]["id"],
        subject=subject,
        max_participants=max_participants,
        checklist_items=items,
    )
    return tpl


@app.post("/api/admin/templates/{template_id}/apply")
def apply_template(template_id: int, request: Request):
    ctx = auth.current_animator(request)
    tpl = storage.get_template(template_id)
    if not tpl:
        raise HTTPException(404, "Template not found")
    p = tpl["payload"]
    room = storage.create_room(
        name=tpl["name"],
        subject=p.get("subject", ""),
        animator_id=ctx["user"]["id"],
        max_participants=min(p.get("max_participants", 50), config.MAX_PARTICIPANTS_PER_ROOM),
        checklist=p.get("checklist_items", []),
    )
    storage.log_event(room["id"], "room_created_from_template", ctx["user"]["id"], {"template_id": template_id})
    return room


@app.delete("/api/admin/templates/{template_id}", status_code=204)
def delete_template(template_id: int, request: Request):
    ctx = auth.current_animator(request)
    tpl = storage.get_template(template_id)
    if not tpl:
        raise HTTPException(404, "Template not found")
    if tpl["animator_id"] != ctx["user"]["id"]:
        raise HTTPException(403)
    storage.delete_template(template_id)


@app.delete("/api/admin/rooms/{room_id}", status_code=204)
def delete_room(room_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.delete_room(room_id)


@app.delete("/api/admin/rooms/{room_id}/enrollments/{enrollment_id}", status_code=204)
def delete_enrollment(room_id: int, enrollment_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.delete_enrollment(room_id, enrollment_id)


@app.delete("/api/admin/rooms/{room_id}/resources/{resource_id}", status_code=204)
def delete_resource(room_id: int, resource_id: int, request: Request):
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.delete_resource(room_id, resource_id)


# ── WebSocket: presence + events ──────────────────────────────────────────────

@app.websocket("/ws/{room_id}")
async def websocket_room(websocket: WebSocket, room_id: int, role: str = Query("participant")):
    sess = websocket.session if hasattr(websocket, "session") else {}
    user_id: int | None = None
    if role == "participant":
        if sess.get("participant_id") and sess.get("participant_room_id") == room_id:
            user_id = sess["participant_id"]
    elif role == "animator":
        token = sess.get("animator_token")
        if token:
            try:
                payload = jwt.decode(
                    token, config.MCP_JWT_SECRET, algorithms=[config.MCP_JWT_ALG],
                    audience=config.MCP_JWT_AUDIENCE, issuer="sfeir-lab-portal",
                    options={"require": ["exp", "sub"]},
                )
                user_obj = storage.upsert_animator(
                    github_id=str(payload["sub"]),
                    github_login=payload.get("github_login", ""),
                    name=payload.get("name", ""),
                )
                if storage.is_animator_of(room_id, user_obj["id"]):
                    user_id = user_obj["id"]
            except Exception:
                pass

    if user_id is None:
        await websocket.close(code=4401)
        return

    await hub.connect(room_id, user_id, websocket)
    storage.touch_user_seen(user_id)
    await hub.broadcast(room_id, {"type": "presence", "active": list(hub.active_user_ids(room_id))})

    try:
        while True:
            await websocket.receive_text()
            storage.touch_user_seen(user_id)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(room_id, websocket)
        await hub.broadcast(room_id, {"type": "presence", "active": list(hub.active_user_ids(room_id))})


# ── WebSocket: Yjs collab ─────────────────────────────────────────────────────

@app.websocket("/yws/{room_id}/{doc_id}")
async def websocket_yjs(websocket: WebSocket, room_id: int, doc_id: str):
    """Binary Y-protocol WS. Auth via session."""
    sess = websocket.session if hasattr(websocket, "session") else {}
    authorized = False
    if sess.get("participant_room_id") == room_id and sess.get("participant_id"):
        authorized = True
    elif sess.get("animator_token"):
        try:
            payload = jwt.decode(
                sess["animator_token"], config.MCP_JWT_SECRET, algorithms=[config.MCP_JWT_ALG],
                audience=config.MCP_JWT_AUDIENCE, issuer="sfeir-lab-portal",
                options={"require": ["exp", "sub"]},
            )
            user_obj = storage.upsert_animator(
                github_id=str(payload["sub"]),
                github_login=payload.get("github_login", ""),
                name=payload.get("name", ""),
            )
            authorized = storage.is_animator_of(room_id, user_obj["id"])
        except Exception:
            pass
    if not authorized:
        await websocket.close(code=4401)
        return
    await yjs_handler(websocket, room_id, doc_id)


# ── Coder workspace endpoints ─────────────────────────────────────────────────

@app.post("/api/rooms/{room_id}/workspace")
async def provision_workspace(room_id: int, request: Request):
    """Called after join — provisions a Coder workspace for this participant."""
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403)
    enrollment_id = request.session.get("enrollment_id")
    if not enrollment_id:
        raise HTTPException(400, "No enrollment in session")

    existing = storage.get_coder_workspace(enrollment_id)
    if existing:
        return existing

    if not coder_client.CODER_TEMPLATE_ID:
        raise HTTPException(503, "Coder not configured")

    try:
        ws = await coder_client.create_workspace(ctx["user"]["display_name"], ctx["user"]["id"])
    except Exception as e:
        raise HTTPException(502, f"Coder error: {e}")

    record = storage.upsert_coder_workspace(
        enrollment_id=enrollment_id,
        room_id=room_id,
        workspace_id=ws["workspace_id"],
        workspace_name=ws["workspace_name"],
        coder_username=ws["coder_username"],
        token=ws["token"],
        coder_password=ws.get("coder_password", ""),
    )
    storage.log_event(room_id, "workspace_created", ctx["user"]["id"], {"workspace_id": ws["workspace_id"]})
    return record


@app.get("/api/rooms/{room_id}/workspace")
async def get_my_workspace(room_id: int, request: Request):
    """Returns current participant's workspace info (incl. token for iframe)."""
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403)
    enrollment_id = request.session.get("enrollment_id")
    ws = storage.get_coder_workspace(enrollment_id)
    if not ws:
        raise HTTPException(404, "No workspace")

    room = storage.get_room(room_id)
    if room and room.get("frozen"):
        return {**ws, "status": "frozen"}
    return ws


@app.get("/api/rooms/{room_id}/workspace/launch")
async def workspace_launch(room_id: int, request: Request):
    """Sets Coder session cookie then redirects to the workspace app (code-server).
    Called as the iframe src so the browser receives the cookie directly."""
    ctx = auth.current_participant(request)
    if ctx["room_id"] != room_id:
        raise HTTPException(403)
    enrollment_id = request.session.get("enrollment_id")
    ws = storage.get_coder_workspace(enrollment_id)
    if not ws:
        raise HTTPException(404, "No workspace")

    coder_base = coder_client.CODER_PUBLIC_URL.rstrip("/")
    app_url = f"{coder_base}/@{ws['coder_username']}/{ws['workspace_name']}/apps/code"

    # Re-login to get a fresh session token (stored token may have expired)
    token = ws["token"]
    if ws.get("coder_password"):
        try:
            token = await coder_client._user_session_token(ws["coder_username"], ws["coder_password"])
        except Exception:
            pass

    response = RedirectResponse(url=app_url, status_code=302)
    response.set_cookie(
        key="coder_session_token",
        value=token,
        path="/",
        samesite="lax",
        httponly=False,
    )
    return response


@app.post("/api/admin/rooms/{room_id}/freeze")
async def admin_freeze(room_id: int, request: Request):
    """Freeze all workspaces in room — blocks iframe access instantly via status flag."""
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.set_room_frozen(room_id, True)
    storage.log_event(room_id, "room_frozen", ctx["user"]["id"], None)
    await hub.broadcast(room_id, {"type": "room_frozen"})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/unfreeze")
async def admin_unfreeze(room_id: int, request: Request):
    """Unfreeze — restores iframe access."""
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    storage.set_room_frozen(room_id, False)
    storage.log_event(room_id, "room_unfrozen", ctx["user"]["id"], None)
    await hub.broadcast(room_id, {"type": "room_unfrozen"})
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/workspaces/{enrollment_id}/stop")
async def admin_stop_workspace(room_id: int, enrollment_id: int, request: Request):
    """Stop one participant's workspace (individual freeze)."""
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    ws = storage.get_coder_workspace(enrollment_id)
    if not ws or ws["room_id"] != room_id:
        raise HTTPException(404)
    try:
        await coder_client.stop_workspace(ws["workspace_id"])
    except Exception as e:
        raise HTTPException(502, str(e))
    storage.update_coder_workspace_status(enrollment_id, "stopped")
    return {"ok": True}


@app.post("/api/admin/rooms/{room_id}/workspaces/{enrollment_id}/start")
async def admin_start_workspace(room_id: int, enrollment_id: int, request: Request):
    """Restart one participant's workspace."""
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    ws = storage.get_coder_workspace(enrollment_id)
    if not ws or ws["room_id"] != room_id:
        raise HTTPException(404)
    try:
        await coder_client.start_workspace(ws["workspace_id"])
    except Exception as e:
        raise HTTPException(502, str(e))
    storage.update_coder_workspace_status(enrollment_id, "running")
    return {"ok": True}


@app.get("/api/admin/rooms/{room_id}/workspaces")
def admin_list_workspaces(room_id: int, request: Request):
    """List all Coder workspaces for a room with statuses."""
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    return storage.list_room_coder_workspaces(room_id)


@app.post("/api/admin/rooms/{room_id}/workspaces/cleanup")
async def admin_cleanup_workspaces(room_id: int, request: Request):
    """Delete all workspaces + ephemeral Coder users for a room."""
    ctx = auth.current_animator(request)
    if not storage.is_animator_of(room_id, ctx["user"]["id"]):
        raise HTTPException(403)
    workspaces = storage.list_room_coder_workspaces(room_id)
    ws_ids = [w["workspace_id"] for w in workspaces]
    usernames = [w["coder_username"] for w in workspaces]
    await coder_client.delete_all_room_workspaces(ws_ids, usernames)
    storage.log_event(room_id, "workspaces_cleaned", ctx["user"]["id"], {"count": len(ws_ids)})
    return {"ok": True, "cleaned": len(ws_ids)}


def main():
    import uvicorn
    uvicorn.run(
        "classroom.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("CLASSROOM_PORT", "8001")),
        workers=1,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
