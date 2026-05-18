"use client";

import { useEffect, useRef, useState } from "react";

export type RoomEvent =
  | { type: "presence"; active: number[] }
  | { type: "help_requested"; help: any; by: string }
  | { type: "help_claimed"; help_id: number; animator: string }
  | { type: "help_resolved"; help_id: number }
  | { type: "submission"; user: string; filename: string; version: number }
  | { type: "progress"; user_id: number; item_id: number; done: boolean }
  | { type: "resource_added"; filename: string; is_starter: boolean }
  | { type: "broadcast"; message: string; from: string; sent_at: number }
  | { type: "spotlight"; content: string; anonymous: boolean; by: string; filename: string }
  | { type: "timer"; timer: any }
  | { type: "room_started" }
  | { type: "room_closed" };

export function useRoomSocket(
  roomId: number,
  role: "participant" | "animator",
  onEvent: (ev: RoomEvent) => void,
) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws/${roomId}?role=${role}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      try { onEventRef.current(JSON.parse(e.data)); } catch {}
    };

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);

    return () => {
      clearInterval(ping);
      ws.close();
    };
  }, [roomId, role]);

  return { connected };
}
