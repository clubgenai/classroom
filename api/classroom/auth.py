"""
Auth model:

- Participants: ephemeral session — they pick a display name + room code, no password.
  Session cookie carries user_id + room_id only.
- Animators: must present a portal-issued JWT (cookie `portal_session` shared with portal,
  or `Authorization: Bearer` header). We verify the JWT with MCP_JWT_SECRET, look up the
  GitHub identity, upsert into `user` table with kind='animator'.
"""

import time
from typing import Optional

import jwt
from fastapi import HTTPException, Request

from . import config, storage


def current_participant(request: Request) -> dict:
    uid = request.session.get("participant_id")
    rid = request.session.get("participant_room_id")
    if not uid or not rid:
        raise HTTPException(401, "Not enrolled — join a room first")
    user = storage.get_user(uid)
    if not user or user["kind"] != "participant":
        request.session.clear()
        raise HTTPException(401, "Participant session invalid")
    storage.touch_user_seen(uid)
    return {"user": user, "room_id": rid}


def _decode_portal_jwt(token: str) -> dict:
    try:
        return jwt.decode(
            token,
            config.MCP_JWT_SECRET,
            algorithms=[config.MCP_JWT_ALG],
            audience=config.MCP_JWT_AUDIENCE,
            issuer="sfeir-lab-portal",
            options={"require": ["exp", "sub"]},
        )
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Invalid portal token: {e}")


def current_animator(request: Request) -> dict:
    """
    Animator auth: portal JWT in `Authorization: Bearer …` OR session cookie
    `animator_token` (set when arriving from portal via redirect).
    """
    token: Optional[str] = None
    h = request.headers.get("Authorization", "")
    if h.startswith("Bearer "):
        token = h[len("Bearer "):]
    if not token:
        token = request.session.get("animator_token")
    if not token:
        raise HTTPException(401, "Animator authentication required")

    payload = _decode_portal_jwt(token)
    github_id = str(payload["sub"])
    github_login = payload.get("github_login") or payload.get("login") or ""
    name = payload.get("name") or github_login or f"user-{github_id}"

    user = storage.upsert_animator(github_id=github_id, github_login=github_login, name=name)
    storage.touch_user_seen(user["id"])
    return {"user": user, "jwt": payload}
