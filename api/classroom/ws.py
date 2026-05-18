"""Single global WebSocket hub. Per-room channels via a dict of sets."""

import asyncio
import json
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self._channels: dict[int, set[WebSocket]] = defaultdict(set)
        self._user_for_ws: dict[WebSocket, int] = {}
        self._lock = asyncio.Lock()

    async def connect(self, room_id: int, user_id: Optional[int], ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._channels[room_id].add(ws)
            if user_id:
                self._user_for_ws[ws] = user_id

    async def disconnect(self, room_id: int, ws: WebSocket) -> None:
        async with self._lock:
            self._channels[room_id].discard(ws)
            self._user_for_ws.pop(ws, None)
            if not self._channels[room_id]:
                self._channels.pop(room_id, None)

    async def broadcast(self, room_id: int, event: dict) -> None:
        payload = json.dumps(event)
        dead: list[WebSocket] = []
        async with self._lock:
            targets = list(self._channels.get(room_id, ()))
        for ws in targets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._channels[room_id].discard(ws)
                    self._user_for_ws.pop(ws, None)

    def active_user_ids(self, room_id: int) -> set[int]:
        return {
            self._user_for_ws[ws]
            for ws in self._channels.get(room_id, ())
            if ws in self._user_for_ws
        }


hub = Hub()
