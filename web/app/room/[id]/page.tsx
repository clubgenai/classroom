"use client";

import { use, useCallback, useEffect, useState } from "react";
import CollabEditor from "@/components/CollabEditor";
import Timer from "@/components/Timer";
import { ToastProvider, useToast } from "@/components/Toast";
import { api, ApiError, ChecklistItem, HelpRequest, Resource, Room, Submission, Timer as TimerType, User } from "@/lib/api";
import { useRoomSocket } from "@/lib/useRoomSocket";

type Bundle = {
  room: Room;
  user: User;
  checklist: ChecklistItem[];
  progress_ids: number[];
  resources: Resource[];
  submissions: Submission[];
  mcp_token: { token_hash: string; scopes: string; expires_at: number; active: number } | null;
  timer: TimerType;
};

export default function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const roomId = parseInt(id, 10);
  return (
    <ToastProvider>
      <RoomInner roomId={roomId} />
    </ToastProvider>
  );
}

function RoomInner({ roomId }: { roomId: number }) {
  const toast = useToast();
  const [data, setData] = useState<Bundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [broadcasts, setBroadcasts] = useState<{ from: string; message: string; sent_at: number }[]>([]);
  const [spotlight, setSpotlight] = useState<{ content: string; anonymous: boolean; by: string; filename: string } | null>(null);
  const [currentResource, setCurrentResource] = useState<Resource | null>(null);
  const [resourceText, setResourceText] = useState<string>("");
  const [helpMsg, setHelpMsg] = useState("");
  const [timer, setTimer] = useState<TimerType>(null);

  const reload = useCallback(async () => {
    try {
      const d = await api.get<Bundle>(`/api/rooms/${roomId}`);
      setData(d);
      setTimer(d.timer);
      if (!currentResource && d.resources.length) {
        loadResource(d.resources[0]);
      }
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [roomId, currentResource]);

  useEffect(() => { reload(); }, [reload]);

  const handleEvent = useCallback((ev: any) => {
    if (ev.type === "broadcast") {
      setBroadcasts((b) => [{ from: ev.from, message: ev.message, sent_at: ev.sent_at }, ...b].slice(0, 20));
    } else if (ev.type === "spotlight") {
      setSpotlight({ content: ev.content, anonymous: ev.anonymous, by: ev.by, filename: ev.filename });
    } else if (ev.type === "timer") {
      setTimer(ev.timer);
    } else if (ev.type === "room_closed") {
      toast.push("La salle est fermée", "error");
    } else if (ev.type === "resource_added") {
      reload();
    }
  }, [reload, toast]);

  useRoomSocket(roomId, "participant", handleEvent);

  if (err) return <div className="p-8 text-red-400">Erreur: {err} — <a href="/" className="underline">Retour</a></div>;
  if (!data) return <div className="p-8 text-muted">Chargement…</div>;

  const loadResource = async (r: Resource) => {
    setCurrentResource(r);
    try {
      const res = await fetch(`/api/rooms/${roomId}/resources/${r.id}/download`, { credentials: "include" });
      setResourceText(await res.text());
    } catch { setResourceText(""); }
  };

  const toggleProgress = async (itemId: number, done: boolean) => {
    await api.form(`/api/rooms/${roomId}/progress`, { item_id: itemId, done });
    reload();
  };

  const askHelp = async () => {
    try {
      await api.form(`/api/rooms/${roomId}/help`, { message: helpMsg });
      toast.push("Demande envoyée", "success");
      setHelpMsg("");
    } catch (e: any) {
      toast.push(e instanceof ApiError ? e.message : String(e), "error");
    }
  };

  const submitFile = async (file: File) => {
    try {
      await api.form(`/api/rooms/${roomId}/submit`, { file });
      toast.push("Soumis", "success");
      reload();
    } catch (e: any) {
      toast.push(e instanceof ApiError ? e.message : String(e), "error");
    }
  };

  const ext = currentResource?.filename.split(".").pop() ?? "txt";
  const lang = ({ js: "javascript", py: "python", md: "markdown", json: "json", html: "html", css: "css", ts: "typescript", tsx: "typescript", jsx: "javascript" } as Record<string, string>)[ext] ?? "plaintext";

  return (
    <div className="h-screen grid grid-rows-[auto_1fr] overflow-hidden">
      <header className="bg-panel border-b border-border px-5 py-3 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">{data.room.name}</h1>
          <span className="text-xs bg-accent px-2 py-0.5 rounded">{data.room.code}</span>
          {data.room.subject && <span className="text-sm text-muted">— {data.room.subject}</span>}
        </div>
        <div className="flex items-center gap-4">
          <Timer timer={timer} />
          <span className="text-sm text-muted">{data.user.display_name}</span>
        </div>
      </header>

      <main className="grid grid-cols-[280px_1fr_320px] overflow-hidden">
        {/* Left sidebar */}
        <aside className="bg-bg border-r border-border p-4 overflow-y-auto">
          <h2 className="label mt-0">Ressources</h2>
          {data.resources.length === 0 && <div className="text-sm text-muted">Aucune ressource</div>}
          {data.resources.map((r) => (
            <button
              key={r.id}
              onClick={() => loadResource(r)}
              className={`w-full text-left p-2 rounded text-sm mb-1 hover:bg-panel ${currentResource?.id === r.id ? "bg-panel border-l-2 border-accent" : ""} ${r.is_starter ? "border-l-2 border-yellow-500" : ""}`}
            >
              {r.filename}
            </button>
          ))}

          <h2 className="label">Checklist</h2>
          {data.checklist.length === 0 && <div className="text-sm text-muted">Pas de checklist</div>}
          {data.checklist.map((item) => {
            const done = data.progress_ids.includes(item.id);
            return (
              <label key={item.id} className="flex items-center p-1 hover:bg-panel rounded cursor-pointer">
                <input type="checkbox" className="mr-2" checked={done} onChange={(e) => toggleProgress(item.id, e.target.checked)} />
                <span className={`text-sm ${done ? "line-through text-muted" : ""}`}>{item.label}</span>
              </label>
            );
          })}

          {data.mcp_token?.active === 1 && (
            <>
              <h2 className="label">Jeton MCP</h2>
              <div className="text-xs text-muted bg-panel p-2 rounded border border-border">Actif</div>
            </>
          )}
        </aside>

        {/* Center: editor */}
        <section className="flex flex-col bg-panel">
          <div className="bg-bg border-b border-border px-4 py-2 flex gap-2 items-center">
            <span className="text-sm text-muted">{currentResource?.filename ?? "Aucune ressource"}</span>
            <div className="flex-1" />
            <FileSubmit onSubmit={submitFile} />
          </div>
          <div className="flex-1 min-h-0">
            {currentResource ? (
              <ReadOnlyEditor key={currentResource.id} value={resourceText} language={lang} />
            ) : (
              <div className="p-6 text-muted">Sélectionne une ressource pour la visualiser.</div>
            )}
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="bg-bg border-l border-border p-4 overflow-y-auto">
          <h2 className="label mt-0">Aide</h2>
          <div className="card mb-4">
            <textarea
              className="input min-h-[60px] mb-2"
              placeholder="Décris le problème (optionnel)"
              value={helpMsg}
              maxLength={500}
              onChange={(e) => setHelpMsg(e.target.value)}
            />
            <button className="btn btn-primary w-full" onClick={askHelp}>Demander de l'aide</button>
          </div>

          <h2 className="label">Mes soumissions</h2>
          {data.submissions.length === 0 && <div className="text-sm text-muted">Aucune soumission</div>}
          {data.submissions.map((s) => (
            <div key={s.id} className="bg-panel p-2 rounded mb-1 text-sm flex justify-between">
              <span>{s.filename}</span>
              <span className="text-muted">v{s.version}</span>
            </div>
          ))}

          <h2 className="label">Broadcasts</h2>
          {broadcasts.length === 0 && <div className="text-sm text-muted">—</div>}
          {broadcasts.map((b, i) => (
            <div key={i} className="bg-panel p-2 rounded mb-1 text-sm">
              <span className="font-semibold text-blue-400">{b.from}: </span>
              <span>{b.message}</span>
            </div>
          ))}

          {spotlight && (
            <>
              <h2 className="label">Spotlight</h2>
              <div className="bg-panel p-2 rounded text-xs">
                <div className="text-muted mb-1">{spotlight.anonymous ? "[anonyme]" : `[${spotlight.filename}]`}</div>
                <pre className="whitespace-pre-wrap overflow-x-auto text-text">{spotlight.content}</pre>
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

import dynamic from "next/dynamic";
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

function ReadOnlyEditor({ value, language }: { value: string; language: string }) {
  return (
    <Editor
      height="100%"
      theme="vs-dark"
      language={language}
      value={value}
      options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
    />
  );
}

function FileSubmit({ onSubmit }: { onSubmit: (f: File) => void }) {
  return (
    <label className="btn btn-primary cursor-pointer">
      Soumettre
      <input
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { onSubmit(f); e.target.value = ""; }
        }}
      />
    </label>
  );
}
