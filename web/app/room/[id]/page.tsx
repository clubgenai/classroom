"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Timer from "@/components/Timer";
import { ToastProvider, useToast } from "@/components/Toast";
import { api, ApiError, ChecklistItem, HelpRequest, Resource, Room, Timer as TimerType, User } from "@/lib/api";
import { useRoomSocket } from "@/lib/useRoomSocket";

type CoderWorkspace = {
  workspace_id: string;
  workspace_name: string;
  coder_username: string;
  token: string;
  status: "running" | "stopped" | "starting" | "stopping" | "frozen";
  url?: string;
};

type Bundle = {
  room: Room & { frozen?: number };
  user: User;
  checklist: ChecklistItem[];
  progress_ids: number[];
  resources: Resource[];
  timer: TimerType;
  mcp_token: { token_hash: string; scopes: string; expires_at: number; active: number } | null;
};

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const CODER_URL = process.env.NEXT_PUBLIC_CODER_URL ?? "";

export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <ToastProvider>
      <RoomInner roomId={parseInt(id, 10)} />
    </ToastProvider>
  );
}

function RoomInner({ roomId }: { roomId: number }) {
  const toast = useToast();
  const [data, setData] = useState<Bundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<CoderWorkspace | null>(null);
  const [wsLoading, setWsLoading] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [broadcasts, setBroadcasts] = useState<{ from: string; message: string; sent_at: number }[]>([]);
  const [helpMsg, setHelpMsg] = useState("");
  const [helpCooldown, setHelpCooldown] = useState(0);
  const [timer, setTimer] = useState<TimerType>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    try {
      const d = await api.get<Bundle>(`/api/rooms/${roomId}`);
      setData(d);
      setTimer(d.timer);
      setFrozen(!!d.room.frozen);
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [roomId]);

  useEffect(() => { reload(); }, [reload]);

  // Provision workspace once room data loaded, then pre-auth Coder session cookie
  useEffect(() => {
    if (!data || workspace || wsLoading || !CODER_URL) return;
    setWsLoading(true);
    setIframeReady(false);
    api.post<CoderWorkspace>(`/api/rooms/${roomId}/workspace`)
      .then(setWorkspace)
      .catch(() => {})
      .finally(() => setWsLoading(false));
  }, [data, workspace, wsLoading, roomId]);

  const handleEvent = useCallback((ev: any) => {
    if (ev.type === "broadcast") {
      setBroadcasts((b) => [{ from: ev.from, message: ev.message, sent_at: ev.sent_at }, ...b].slice(0, 10));
      toast.push(`${ev.from}: ${ev.message}`, "info");
    } else if (ev.type === "timer") {
      setTimer(ev.timer);
    } else if (ev.type === "room_frozen") {
      setFrozen(true);
      toast.push("L'animateur a suspendu l'accès VS Code", "error");
    } else if (ev.type === "room_unfrozen") {
      setFrozen(false);
      toast.push("Accès VS Code rétabli", "success");
    } else if (ev.type === "room_closed") {
      toast.push("La salle est fermée", "error");
    }
  }, [toast]);

  useRoomSocket(roomId, "participant", handleEvent);

  const askHelp = async () => {
    if (helpCooldown > 0) return;
    try {
      await api.form(`/api/rooms/${roomId}/help`, { message: helpMsg });
      toast.push("Demande envoyée", "success");
      setHelpMsg("");
      setHelpCooldown(30);
      cooldownRef.current = setInterval(() => {
        setHelpCooldown((c) => {
          if (c <= 1) { clearInterval(cooldownRef.current!); return 0; }
          return c - 1;
        });
      }, 1000);
    } catch (e: any) {
      toast.push(e instanceof ApiError ? e.message : String(e), "error");
    }
  };

  const toggleProgress = async (itemId: number, done: boolean) => {
    await api.form(`/api/rooms/${roomId}/progress`, { item_id: itemId, done });
    reload();
  };

  if (err) return <div className="p-8 text-red-400">Erreur: {err} — <a href="/classroom" className="underline">Retour</a></div>;
  if (!data) return <div className="p-8 text-muted">Chargement…</div>;

  const doneCount = data.progress_ids.length;
  const totalCount = data.checklist.length;

  // Launch URL: classroom-api sets coder_session_token cookie then redirects to VS Code app
  const iframeUrl = workspace && CODER_URL
    ? `${BASE}/api/rooms/${roomId}/workspace/launch`
    : null;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* ── Navbar ── */}
      <header className="bg-panel border-b border-border px-4 py-2 flex items-center gap-3 shrink-0 z-10">
        <h1 className="font-semibold text-sm truncate max-w-[180px]">{data.room.name}</h1>
        {data.room.subject && (
          <span className="text-xs text-muted truncate hidden sm:block">— {data.room.subject}</span>
        )}

        <div className="flex-1" />

        {/* Timer */}
        <Timer timer={timer} />

        {/* Checklist progress badge */}
        {totalCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-16 h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className={`h-full rounded-full ${doneCount === totalCount ? "bg-green-500" : "bg-accent"}`}
                style={{ width: `${(doneCount / totalCount) * 100}%` }}
              />
            </div>
            <span>{doneCount}/{totalCount}</span>
          </div>
        )}

        {/* Freeze overlay indicator */}
        {frozen && (
          <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded font-semibold animate-pulse">
            SUSPENDU
          </span>
        )}

        {/* Workspace status */}
        {CODER_URL && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${
            wsLoading ? "text-muted" :
            workspace ? "text-green-400" : "text-yellow-500"
          }`}>
            {wsLoading ? "VS Code…" : workspace ? "VS Code actif" : "Sans VS Code"}
          </span>
        )}

        {/* Help + panel toggle */}
        <button
          onClick={() => setPanelOpen((o) => !o)}
          className={`btn text-xs relative ${broadcasts.length > 0 ? "text-blue-400" : ""}`}
        >
          {panelOpen ? "Fermer" : "Panneau"}
          {broadcasts.length > 0 && (
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-blue-500" />
          )}
        </button>

        <button
          className={`btn btn-primary text-xs ${helpCooldown > 0 ? "opacity-50" : ""}`}
          onClick={askHelp}
          disabled={helpCooldown > 0}
          title="Lever la main"
        >
          {helpCooldown > 0 ? `🙋 ${helpCooldown}s` : "🙋 Aide"}
        </button>

        <span className="text-xs text-muted hidden sm:block">{data.user.display_name}</span>
        <button onClick={() => { api.post("/api/logout").catch(() => {}); window.location.href = "/classroom"; }} className="btn text-xs">
          Quitter
        </button>
      </header>

      {/* ── Main: iframe + side panel ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* VS Code iframe */}
        <div className="flex-1 relative">
          {frozen ? (
            <div className="h-full flex items-center justify-center bg-bg">
              <div className="text-center">
                <div className="text-4xl mb-4">🔒</div>
                <p className="text-muted">L'animateur a suspendu l'accès temporairement.</p>
              </div>
            </div>
          ) : iframeUrl ? (
            <>
              <iframe
                src={iframeUrl}
                className="w-full h-full border-0"
                allow="clipboard-read; clipboard-write"
                title="VS Code"
                onLoad={() => setIframeReady(true)}
              />
              {!iframeReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-bg">
                  <div className="text-center">
                    <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                    <p className="text-sm text-muted">Démarrage de l'environnement VS Code…</p>
                    <p className="text-xs text-muted mt-1 opacity-60">Première connexion : ~30–60 secondes</p>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="h-full flex items-center justify-center bg-bg">
              <div className="text-center text-muted text-sm">
                {wsLoading ? "Préparation de l'environnement VS Code…" : "Environnement VS Code non disponible"}
              </div>
            </div>
          )}
        </div>

        {/* Side panel — checklist + help + broadcasts */}
        {panelOpen && (
          <aside className="w-72 bg-bg border-l border-border flex flex-col overflow-hidden shrink-0">
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
              {/* Help */}
              <div>
                <h2 className="label mt-0">Demander de l'aide</h2>
                <textarea
                  className="input min-h-[60px] mb-2 text-sm"
                  placeholder="Décris ton problème (optionnel)"
                  value={helpMsg}
                  maxLength={500}
                  onChange={(e) => setHelpMsg(e.target.value)}
                  disabled={helpCooldown > 0}
                />
                <button
                  className="btn btn-primary w-full text-sm"
                  onClick={askHelp}
                  disabled={helpCooldown > 0}
                >
                  {helpCooldown > 0 ? `🙋 Attendre ${helpCooldown}s` : "🙋 Lever la main"}
                </button>
              </div>

              {/* Checklist */}
              {totalCount > 0 && (
                <div>
                  <h2 className="label">Checklist</h2>
                  {data.checklist.map((item) => {
                    const done = data.progress_ids.includes(item.id);
                    return (
                      <label key={item.id} className="flex items-start gap-2 p-1.5 hover:bg-panel rounded cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5 shrink-0"
                          checked={done}
                          onChange={(e) => toggleProgress(item.id, e.target.checked)}
                        />
                        <span className={`text-sm ${done ? "line-through text-muted" : ""}`}>{item.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}

              {/* Broadcasts */}
              {broadcasts.length > 0 && (
                <div>
                  <h2 className="label">Messages</h2>
                  {broadcasts.map((b, i) => (
                    <div key={i} className="bg-panel p-2 rounded mb-1 text-sm border-l-2 border-blue-500">
                      <div className="text-xs text-blue-400 font-semibold mb-0.5">{b.from}</div>
                      <div>{b.message}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
