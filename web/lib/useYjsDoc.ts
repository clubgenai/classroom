"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

export function useYjsDoc(roomId: number, docId: string, userName: string) {
  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    const doc = new Y.Doc();
    docRef.current = doc;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/yws`;

    // y-websocket appends `/<roomName>` to wsUrl. Use `${roomId}/${docId}` as room name.
    const provider = new WebsocketProvider(wsUrl, `${roomId}/${docId}`, doc, {
      protocols: ["y"],
    });
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", {
      name: userName,
      color: stringToColor(userName),
    });

    provider.on("sync", (isSynced: boolean) => setSynced(isSynced));

    return () => {
      provider.destroy();
      doc.destroy();
    };
  }, [roomId, docId, userName]);

  return { doc: docRef.current, provider: providerRef.current, synced };
}

function stringToColor(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 70%, 55%)`;
}
