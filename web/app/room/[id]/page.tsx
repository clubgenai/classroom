"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
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
  help_requests: HelpRequest[];
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

function fmtTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function fmtExpiry(exp: number) {
  const diff = exp - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "expiré";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  return `${Math.floor(diff / 3600)}h${Math.floor((diff % 3600) / 60).toString().padStart(2, "0")}`;
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
  const [helpCooldown, setHelpCooldown] = useState(0);
  const [timer, setTimer] = useState<TimerType>(null);
  const [editorMode, setEditorMode] = useState<"resource" | "editor">("resource");
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    } else if (["help_claimed", "help_resolved"].includes(ev.type)) {
      reload();
    }
  }, [reload, toast]);

  useRoomSocket(roomId, "participant", handleEvent);

  const leave = async () => {
    await api.post("/api/logout").catch(() => {});
    window.location.href = "/classroom";
  };

  if (err) return <div className="p-8 text-red-400">Erreur: {err} — <a href="/classroom" className="underline">Retour</a></div>;
  if (!data) return <div className="p-8 text-muted">Chargement…</div>;

  const loadResource = async (r: Resource) => {
    setCurrentResource(r);
    try {
      const res = await fetch(`/classroom/api/rooms/${roomId}/resources/${r.id}/download`, { credentials: "include" });
      if (res.ok) setResourceText(await res.text());
      else setResourceText(`// Erreur chargement (${res.status})`);
    } catch { setResourceText("// Impossible de charger ce fichier"); }
  };

  const toggleProgress = async (itemId: number, done: boolean) => {
    await api.form(`/api/rooms/${roomId}/progress`, { item_id: itemId, done });
    reload();
  };

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

  const submitFile = async (file: File) => {
    try {
      await api.form(`/api/rooms/${roomId}/submit`, { file });
      toast.push("Soumis", "success");
      reload();
    } catch (e: any) {
      toast.push(e instanceof ApiError ? e.message : String(e), "error");
    }
  };

  const copyCode = () => {
    navigator.clipboard.writeText(data.room.code).then(() => toast.push("Code copié", "success"));
  };

  const ext = currentResource?.filename.split(".").pop() ?? "txt";
  const lang = ({ js: "javascript", py: "python", md: "markdown", json: "json", html: "html", css: "css", ts: "typescript", tsx: "typescript", jsx: "javascript" } as Record<string, string>)[ext] ?? "plaintext";

  const doneCount = data.progress_ids.length;
  const totalCount = data.checklist.length;

  const mcpToken = data.mcp_token?.active === 1 ? data.mcp_token : null;
  const mcpExpiring = mcpToken && (mcpToken.expires_at - Math.floor(Date.now() / 1000)) < 1800;

  const myHelp = data.help_requests?.filter((h) => h.user_id === data.user.id) ?? [];

  return (
    <div className="h-screen grid grid-rows-[auto_1fr] overflow-hidden">
      <header className="bg-panel border-b border-border px-5 py-3 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">{data.room.name}</h1>
          <button
            onClick={copyCode}
            title="Cliquer pour copier"
            className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded hover:bg-accent/40 transition-colors cursor-pointer font-mono tracking-widest"
          >
            {data.room.code}
          </button>
          {data.room.subject && <span className="text-sm text-muted">— {data.room.subject}</span>}
        </div>
        <div className="flex items-center gap-4">
          <Timer timer={timer} />
          <span className="text-sm text-muted">{data.user.display_name}</span>
          <button onClick={leave} className="btn text-xs">Quitter</button>
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
              <span>{r.filename}</span>
              {r.is_starter === 1 && <span className="ml-1 text-yellow-500 text-xs">starter</span>}
            </button>
          ))}

          <h2 className="label">
            Checklist
            {totalCount > 0 && (
              <span className={`ml-2 text-xs font-normal ${doneCount === totalCount ? "text-green-400" : "text-muted"}`}>
                {doneCount}/{totalCount}
              </span>
            )}
          </h2>
          {totalCount > 0 && (
            <div className="h-1 rounded-full bg-border overflow-hidden mb-2">
              <div
                className={`h-full rounded-full transition-all ${doneCount === totalCount ? "bg-green-500" : "bg-accent"}`}
                style={{ width: `${totalCount > 0 ? (doneCount / totalCount) * 100 : 0}%` }}
              />
            </div>
          )}
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

          {mcpToken && (
            <>
              <h2 className="label">Jeton MCP</h2>
              <div className={`text-xs p-2 rounded border ${mcpExpiring ? "bg-red-900/30 border-red-700 text-red-300" : "bg-panel border-border text-muted"}`}>
                <div className="flex justify-between">
                  <span>Actif</span>
                  <span className={mcpExpiring ? "text-red-300 font-semibold" : ""}>
                    {fmtExpiry(mcpToken.expires_at)}
                  </span>
                </div>
                {mcpToken.scopes && (
                  <div className="mt-1 text-xs opacity-70">{mcpToken.scopes}</div>
                )}
              </div>
            </>
          )}
        </aside>

        {/* Center: editor */}
        <section className="flex flex-col bg-panel">
          <div className="bg-bg border-b border-border px-4 py-2 flex gap-2 items-center">
            <button
              className={`text-xs px-3 py-1 rounded ${editorMode === "resource" ? "bg-accent text-white" : "text-muted hover:text-text"}`}
              onClick={() => setEditorMode("resource")}
            >
              Ressource
            </button>
            <button
              className={`text-xs px-3 py-1 rounded ${editorMode === "editor" ? "bg-accent text-white" : "text-muted hover:text-text"}`}
              onClick={() => setEditorMode("editor")}
            >
              Mon éditeur
            </button>
            {editorMode === "resource" && (
              <span className="text-sm text-muted">{currentResource?.filename ?? "Aucune ressource"}</span>
            )}
            <div className="flex-1" />
            <FileSubmit onSubmit={submitFile} />
          </div>
          <div className="flex-1 min-h-0">
            {editorMode === "resource" ? (
              currentResource ? (
                <ReadOnlyEditor key={currentResource.id} value={resourceText} language={lang} />
              ) : (
                <div className="p-6 text-muted">Sélectionne une ressource pour la visualiser.</div>
              )
            ) : (
              <CollabEditor
                roomId={data.room.id}
                docId={`participant-${data.user.id}`}
                userName={data.user.display_name}
                language={lang}
                readOnly={false}
                height="100%"
              />
            )}
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="bg-bg border-l border-border p-4 overflow-y-auto space-y-4">
          <div>
            <h2 className="label mt-0">Aide</h2>
            <div className="card mb-2">
              <textarea
                className="input min-h-[60px] mb-2"
                placeholder="Décris le problème (optionnel)"
                value={helpMsg}
                maxLength={500}
                onChange={(e) => setHelpMsg(e.target.value)}
                disabled={helpCooldown > 0}
              />
              <button
                className="btn btn-primary w-full"
                onClick={askHelp}
                disabled={helpCooldown > 0}
              >
                {helpCooldown > 0 ? `Demander de l'aide (${helpCooldown}s)` : "Demander de l'aide"}
              </button>
            </div>
            {myHelp.length > 0 && (
              <div className="space-y-1">
                {myHelp.slice(0, 3).map((h) => (
                  <div key={h.id} className={`text-xs p-2 rounded border ${
                    h.status === "resolved" ? "border-green-800 text-green-400 bg-green-900/20" :
                    h.status === "claimed" ? "border-blue-800 text-blue-300 bg-blue-900/20" :
                    "border-border text-muted bg-panel"
                  }`}>
                    <span className="font-medium capitalize">{h.status === "pending" ? "En attente" : h.status === "claimed" ? "Pris en charge" : "Résolu"}</span>
                    {h.message && <span className="ml-2 opacity-70">{h.message.slice(0, 40)}{h.message.length > 40 ? "…" : ""}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="label">Mes soumissions</h2>
            {data.submissions.length === 0 && <div className="text-sm text-muted">Aucune soumission</div>}
            {data.submissions.map((s) => (
              <div key={s.id} className="bg-panel p-2 rounded mb-1 text-sm flex justify-between">
                <span>{s.filename}</span>
                <span className="text-muted">v{s.version}</span>
              </div>
            ))}
          </div>

          {broadcasts.length > 0 && (
            <div>
              <h2 className="label">Messages</h2>
              {broadcasts.map((b, i) => (
                <div key={i} className="bg-panel p-2 rounded mb-1 text-sm">
                  <div className="flex justify-between items-baseline mb-0.5">
                    <span className="font-semibold text-blue-400 text-xs">{b.from}</span>
                    <span className="text-xs text-muted">{fmtTime(b.sent_at)}</span>
                  </div>
                  <span>{b.message}</span>
                </div>
              ))}
            </div>
          )}

          {spotlight && (
            <div>
              <h2 className="label">Spotlight</h2>
              <div className="bg-panel p-2 rounded text-xs">
                <div className="text-muted mb-1">{spotlight.anonymous ? "[anonyme]" : `[${spotlight.filename}]`}</div>
                <pre className="whitespace-pre-wrap overflow-x-auto text-text">{spotlight.content}</pre>
              </div>
            </div>
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
