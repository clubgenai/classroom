"""Thin async wrapper around the Coder API for workspace lifecycle management."""

import asyncio
import os
import uuid
from typing import Optional

import httpx

CODER_URL = os.environ.get("CODER_URL", "http://coder.sfeir-lab.local")
CODER_TOKEN = os.environ.get("CODER_ADMIN_TOKEN", "")
CODER_TEMPLATE_ID = os.environ.get("CODER_TEMPLATE_ID", "")
CODER_ORG_ID = os.environ.get("CODER_ORG_ID", "")
# Workspace TTL: 12h in ms
WORKSPACE_TTL_MS = int(os.environ.get("CODER_WORKSPACE_TTL_MS", str(12 * 3600 * 1000)))

_HEADERS = {"Coder-Session-Token": CODER_TOKEN, "Content-Type": "application/json"}


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=CODER_URL, headers=_HEADERS, timeout=30.0)


def _username(display_name: str, user_id: int) -> str:
    """Deterministic Coder username from Classroom participant."""
    safe = "".join(c.lower() if c.isalnum() else "-" for c in display_name)[:20].strip("-")
    return f"p-{safe}-{user_id}"


async def ensure_user(display_name: str, user_id: int) -> dict:
    """Create ephemeral Coder user if not exists. Returns Coder user dict."""
    username = _username(display_name, user_id)
    async with _client() as c:
        r = await c.get(f"/api/v2/users/{username}")
        if r.status_code == 200:
            return r.json()
        payload = {
            "username": username,
            "email": f"{username}@classroom.local",
            "name": display_name,
            "password": str(uuid.uuid4()),
            "login_type": "password",
            "organization_ids": [CODER_ORG_ID],
        }
        r = await c.post("/api/v2/users", json=payload)
        r.raise_for_status()
        return r.json()


async def create_workspace(display_name: str, user_id: int) -> dict:
    """Create workspace for participant. Returns {workspace_id, workspace_name, token, url}."""
    coder_user = await ensure_user(display_name, user_id)
    username = coder_user["username"]

    async with _client() as c:
        ws_name = f"tp-{user_id}-{uuid.uuid4().hex[:6]}"
        r = await c.post(
            f"/api/v2/organizations/{CODER_ORG_ID}/members/{username}/workspaces",
            json={
                "name": ws_name,
                "template_id": CODER_TEMPLATE_ID,
                "ttl_ms": WORKSPACE_TTL_MS,
                "automatic_updates": "never",
            },
        )
        r.raise_for_status()
        ws = r.json()
        ws_id = ws["id"]

        # Create a short-lived session token for this user
        token_r = await c.post(
            f"/api/v2/users/{username}/keys/tokens",
            json={"lifetime": WORKSPACE_TTL_MS // 1000, "token_name": f"classroom-{ws_id[:8]}"},
        )
        token_r.raise_for_status()
        token = token_r.json()["key"]

    return {
        "workspace_id": ws_id,
        "workspace_name": ws_name,
        "coder_username": username,
        "token": token,
        "url": f"{CODER_URL}/@{username}/{ws_name}",
    }


async def stop_workspace(workspace_id: str) -> None:
    """Stop (freeze) a workspace — blocks access without deleting data."""
    async with _client() as c:
        r = await c.post(
            f"/api/v2/workspaces/{workspace_id}/builds",
            json={"transition": "stop"},
        )
        r.raise_for_status()


async def start_workspace(workspace_id: str) -> None:
    """Restart a frozen workspace."""
    async with _client() as c:
        r = await c.post(
            f"/api/v2/workspaces/{workspace_id}/builds",
            json={"transition": "start"},
        )
        r.raise_for_status()


async def delete_workspace(workspace_id: str) -> None:
    """Permanently delete workspace and its data."""
    async with _client() as c:
        r = await c.post(
            f"/api/v2/workspaces/{workspace_id}/builds",
            json={"transition": "delete"},
        )
        r.raise_for_status()


async def delete_user(coder_username: str) -> None:
    """Delete ephemeral Coder user. Called at session cleanup."""
    async with _client() as c:
        r = await c.get(f"/api/v2/users/{coder_username}")
        if r.status_code != 200:
            return
        user_id = r.json()["id"]
        await c.delete(f"/api/v2/users/{user_id}")


async def workspace_status(workspace_id: str) -> Optional[str]:
    """Returns 'running' | 'stopped' | 'starting' | 'stopping' | 'deleted' | None."""
    async with _client() as c:
        r = await c.get(f"/api/v2/workspaces/{workspace_id}")
        if r.status_code != 200:
            return None
        latest = r.json().get("latest_build", {})
        return latest.get("status")


async def delete_all_room_workspaces(workspace_ids: list[str], coder_usernames: list[str]) -> None:
    """Cleanup all workspaces + users for a room. Called on close_room."""
    await asyncio.gather(
        *[delete_workspace(wid) for wid in workspace_ids],
        return_exceptions=True,
    )
    await asyncio.gather(
        *[delete_user(u) for u in coder_usernames],
        return_exceptions=True,
    )
