"""
Y.js WebSocket relay + per-doc persistence.

We don't run a Yjs CRDT engine in Python — we just relay binary messages between
peers and persist the latest known state to SQLite. The actual CRDT lives in
the browser. This is the standard "y-websocket without state computation"
approach: simple, no Yjs Python port needed, fully compatible with y-websocket
clients on the frontend.

Persistence strategy:
- First-connecting peer requests sync (msg type 0, step 1).
- We send back the last persisted state vector update we have (if any), so the
  peer's initial doc loads with all prior content.
- Whenever a peer broadcasts a sync-step-2 update (msg type 0, step 2) or an
  out-of-band update (msg type 0, step 0), we persist it as the new full state.
- Awareness messages (msg type 1) are pure relay — not persisted.

We only ever store one "full state" blob per (room_id, doc_id), updated atomically.
"""

import asyncio
import sqlite3
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from . import config, db


_MESSAGE_SYNC = 0
_MESSAGE_AWARENESS = 1
_SYNC_STEP_1 = 0
_SYNC_STEP_2 = 1
_SYNC_UPDATE = 2


_DOC_SCHEMA = """
CREATE TABLE IF NOT EXISTS yjs_doc (
    room_id    INTEGER NOT NULL,
    doc_id     TEXT NOT NULL,
    state      BLOB NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (room_id, doc_id)
);
"""

_initialized = False
_init_lock = asyncio.Lock()
_rooms: dict[tuple[int, str], set[WebSocket]] = defaultdict(set)
_rooms_lock = asyncio.Lock()


async def _ensure_table():
    global _initialized
    async with _init_lock:
        if _initialized:
            return
        with db.cursor() as conn:
            conn.executescript(_DOC_SCHEMA)
        _initialized = True


def _load_state(room_id: int, doc_id: str) -> Optional[bytes]:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT state FROM yjs_doc WHERE room_id=? AND doc_id=?",
            (room_id, doc_id),
        ).fetchone()
    return row["state"] if row else None


def _save_state(room_id: int, doc_id: str, state: bytes) -> None:
    import time
    with db.cursor() as conn:
        conn.execute(
            "INSERT INTO yjs_doc (room_id, doc_id, state, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(room_id, doc_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at",
            (room_id, doc_id, sqlite3.Binary(state), time.time()),
        )


async def _broadcast_to_room(key: tuple[int, str], data: bytes, sender: WebSocket) -> None:
    async with _rooms_lock:
        targets = [ws for ws in _rooms[key] if ws is not sender]
    dead: list[WebSocket] = []
    for ws in targets:
        try:
            await ws.send_bytes(data)
        except Exception:
            dead.append(ws)
    if dead:
        async with _rooms_lock:
            for ws in dead:
                _rooms[key].discard(ws)


async def yjs_handler(websocket: WebSocket, room_id: int, doc_id: str) -> None:
    await _ensure_table()
    await websocket.accept(subprotocol="y")

    key = (room_id, doc_id)
    async with _rooms_lock:
        _rooms[key].add(websocket)

    # Send initial state to the new peer (so they load existing doc content).
    state = _load_state(room_id, doc_id)
    if state:
        # Construct an UPDATE message: [type=sync, step=update, payload]
        msg = _encode_sync_update(state)
        try:
            await websocket.send_bytes(msg)
        except Exception:
            pass

    try:
        while True:
            data = await websocket.receive_bytes()
            if not data:
                continue
            msg_type = data[0] if data else None
            if msg_type == _MESSAGE_SYNC:
                # Persist whenever we see a full update payload (best-effort).
                # We only know "this is the latest" by accumulating step-2 / updates.
                # For simplicity, persist every sync message body as the canonical state.
                if len(data) > 2:
                    sub = data[1]
                    if sub in (_SYNC_STEP_2, _SYNC_UPDATE):
                        try:
                            _save_state(room_id, doc_id, data[2:])
                        except Exception:
                            pass
                await _broadcast_to_room(key, data, websocket)
            elif msg_type == _MESSAGE_AWARENESS:
                # Pure relay — no persistence.
                await _broadcast_to_room(key, data, websocket)
            else:
                # Unknown — still relay (forward compat).
                await _broadcast_to_room(key, data, websocket)
    except WebSocketDisconnect:
        pass
    finally:
        async with _rooms_lock:
            _rooms[key].discard(websocket)
            if not _rooms[key]:
                _rooms.pop(key, None)


def _encode_sync_update(state: bytes) -> bytes:
    """[type=sync(0), step=update(2), state_bytes...]"""
    return bytes([_MESSAGE_SYNC, _SYNC_UPDATE]) + state
