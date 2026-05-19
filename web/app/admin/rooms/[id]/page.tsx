"use client";

import { use, useCallback, useEffect, useState } from "react";
import { api, ApiError, ChecklistItem, Enrollment, HelpRequest, Resource, Room, Submission, Timer as TimerType, User } from "@/lib/api";
import { useRoomSocket } from "@/lib/useRoomSocket";
import Timer from "@/components/Timer";
import { ToastProvider, useToast } from "@/components/Toast";

type Bundle = {
  room: Room;
  animators: User[];
  enrollments: Enrollment[];
  help_requests: HelpRequest[];
  submissions: Submission[];
  resources: Resource[];
  checklist: ChecklistItem[];
  progress_summary: { user_id: number; display_name: string; done_count: number; total: number }[];
  stats: { enrolled: number; submitted: number; help_requests: number; checklist_total: number; checklist_done: number };
  timer: TimerType;
};

export default function AdminRoom({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const roomId = parseInt(id, 10);
  return <ToastProvider><Inner roomId={roomId} /></ToastProvider>;
}

function Inner({ roomId }: { roomId: number }) {
  const toast = useToast();
  const [data, setData] = useState<Bundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [timer, setTimer] = useState<TimerType>(null);
  const [tokens, setTokens] = useState<Record<number, string>>({});

  const reload = useCallback(async () => {
    try {
      const d = await api.get<Bundle>(`/api/admin/rooms/${roomId}`);
      setData(d);
      setTimer(d.timer);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) {
        window.location.href = `/portal?next=/classroom/admin/rooms/${roomId}`;
        return;
      }
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [roomId]);

  useEffect(() => { reload(); }, [reload]);

  useRoomSocket(roomId, "animator", (ev: any) => {
    if (ev.type === "timer") setTimer(ev.timer);
    if (["help_requested", "help_claimed", "help_resolved", "submission", "progress", "resource_added"].includes(ev.type)) {
      reload();
    }
  });

  if (err) return <div className="p-8 text-red-400">{err} — <a href="/classroom/admin" className="underline">retour</a></div>;
  if (!data) return <div className="p-8 text-muted">Chargement…</div>;

  const broadcast = async (msg: string) => {
    try { await api.form(`/api/admin/rooms/${roomId}/broadcast`, { message: msg }); toast.push("Envoyé", "success"); }
    catch (e: any) { toast.push(e.message, "error"); }
  };

  const setTimerSeconds = async (seconds: number) => {
    await api.form(`/api/admin/rooms/${roomId}/timer`, { action: "set", duration_seconds: seconds });
  };
  const startTimer = () => api.form(`/api/admin/rooms/${roomId}/timer`, { action: "start" });
  const pauseTimer = () => api.form(`/api/admin/rooms/${roomId}/timer`, { action: "pause" });

  const startRoom = () => api.post(`/api/admin/rooms/${roomId}/start`).then(reload);
  const closeRoom = () => { if (confirm("Fermer la salle ?")) api.post(`/api/admin/rooms/${roomId}/close`).then(reload); };

  const uploadResource = async (file: File, starter: boolean) => {
    try { await api.form(`/api/admin/rooms/${roomId}/resources`, { file, is_starter: starter }); toast.push("Uploadée", "success"); reload(); }
    catch (e: any) { toast.push(e.message, "error"); }
  };

  const claimHelp = (h: HelpRequest) => api.post(`/api/admin/rooms/${roomId}/help/${h.id}/claim`).then(reload);
  const resolveHelp = (h: HelpRequest) => api.post(`/api/admin/rooms/${roomId}/help/${h.id}/resolve`).then(reload);

  const activateToken = async (enr: Enrollment) => {
    try {
      const r = await api.form<{ token: string }>(`/api/admin/rooms/${roomId}/tokens/${enr.id}/activate`, { ttl_seconds: 3 * 3600 });
      setTokens((t) => ({ ...t, [enr.id]: r.token }));
      toast.push("Jeton émis", "success");
    } catch (e: any) { toast.push(e.message, "error"); }
  };

  const revokeToken = async (enr: Enrollment) => {
    await api.post(`/api/admin/rooms/${roomId}/tokens/${enr.id}/revoke`);
    setTokens((t) => { const n = { ...t }; delete n[enr.id]; return n; });
    toast.push("Jeton révoqué", "success");
  };

  const spotlight = async (sub: Submission, anonymous: boolean) => {
    await api.form(`/api/admin/rooms/${roomId}/spotlight`, {
      target_user_id: sub.user_id, submission_id: sub.id, anonymous,
    });
    toast.push("Spotlight envoyé", "success");
  };

  return (
    <main className="min-h-screen grid grid-cols-[1fr_360px]">
      <section className="p-6 overflow-y-auto max-h-screen">
        <header className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-semibold">{data.room.name}</h1>
            <div className="text-muted">{data.room.subject || ""} — code <span className="font-mono text-accent">{data.room.code}</span></div>
          </div>
          <div className="flex gap-2 items-center">
            <Timer timer={timer} />
            {data.room.status === "open" && <button className="btn btn-primary" onClick={startRoom}>Démarrer</button>}
            {data.room.status !== "closed" && <button className="btn btn-danger" onClick={closeRoom}>Fermer</button>}
            <a href="/classroom/admin" className="btn">←</a>
          </div>
        </header>

        <Stats stats={data.stats} />

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="card">
            <h2 className="font-semibold mb-2">Timer</h2>
            <div className="flex gap-2 flex-wrap">
              <button className="btn" onClick={() => setTimerSeconds(15 * 60)}>15 min</button>
              <button className="btn" onClick={() => setTimerSeconds(30 * 60)}>30 min</button>
              <button className="btn" onClick={() => setTimerSeconds(60 * 60)}>1 h</button>
              <button className="btn btn-primary" onClick={startTimer}>▶</button>
              <button className="btn" onClick={pauseTimer}>⏸</button>
            </div>
          </div>

          <div className="card">
            <h2 className="font-semibold mb-2">Broadcast</h2>
            <BroadcastForm onSubmit={broadcast} />
          </div>
        </div>

        <div className="card mt-4">
          <h2 className="font-semibold mb-2">Ressources</h2>
          <UploadForm onSubmit={uploadResource} />
          <div className="mt-3 space-y-1">
            {data.resources.map((r) => (
              <div key={r.id} className="flex justify-between bg-bg p-2 rounded text-sm">
                <span>{r.is_starter ? "⭐ " : ""}{r.filename}</span>
                <span className="text-muted">{Math.ceil(r.size_bytes / 1024)} kB</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card mt-4">
          <h2 className="font-semibold mb-2">Soumissions</h2>
          {data.submissions.length === 0 && <div className="text-muted text-sm">Aucune</div>}
          <div className="space-y-1">
            {data.submissions.map((s) => (
              <div key={s.id} className="flex justify-between items-center bg-bg p-2 rounded text-sm">
                <span><strong>{s.display_name}</strong> — {s.filename} <span className="text-muted">v{s.version}</span></span>
                <div className="flex gap-1">
                  <a className="btn text-xs" href={`/api/admin/rooms/${roomId}/submissions/${s.id}/download`} target="_blank" rel="noreferrer">↓</a>
                  <button className="btn text-xs" onClick={() => spotlight(s, false)}>Spot</button>
                  <button className="btn text-xs" onClick={() => spotlight(s, true)}>Spot anon</button>
                </div>
              </div>
            ))}
          </div>
          <a className="btn mt-3 inline-block" href={`/api/admin/rooms/${roomId}/export`} target="_blank" rel="noreferrer">Export ZIP</a>
        </div>

        <div className="card mt-4">
          <h2 className="font-semibold mb-2">Checklist · progrès</h2>
          {data.progress_summary.map((p) => (
            <div key={p.user_id} className="text-sm py-1 border-b border-border last:border-0 flex justify-between">
              <span>{p.display_name}</span>
              <span className="text-muted">{p.done_count}/{p.total}</span>
            </div>
          ))}
        </div>
      </section>

      <aside className="bg-bg border-l border-border p-4 overflow-y-auto max-h-screen">
        <h2 className="label mt-0">File d'aide</h2>
        {data.help_requests.length === 0 && <div className="text-sm text-muted">Vide</div>}
        {data.help_requests.map((h) => (
          <div key={h.id} className="card mb-2">
            <div className="flex justify-between text-sm">
              <strong>{h.display_name}</strong>
              <span className={`text-xs ${h.status === "in_progress" ? "text-yellow-400" : "text-muted"}`}>{h.status}</span>
            </div>
            {h.message && <p className="text-sm mt-1 text-muted">{h.message}</p>}
            <div className="flex gap-1 mt-2">
              {h.status === "pending" && <button className="btn btn-primary text-xs" onClick={() => claimHelp(h)}>Prendre</button>}
              <button className="btn text-xs" onClick={() => resolveHelp(h)}>Résoudre</button>
            </div>
          </div>
        ))}

        <h2 className="label">Participants</h2>
        {data.enrollments.length === 0 && <div className="text-sm text-muted">Aucun</div>}
        {data.enrollments.map((e) => (
          <div key={e.id} className="card mb-2">
            <div className="text-sm font-medium">{e.display_name}</div>
            {tokens[e.id] ? (
              <>
                <div className="text-[10px] font-mono text-muted break-all mt-1 select-all">{tokens[e.id]}</div>
                <button className="btn btn-danger text-xs mt-2 w-full" onClick={() => revokeToken(e)}>Révoquer</button>
              </>
            ) : (
              <button className="btn text-xs mt-2 w-full" onClick={() => activateToken(e)}>Émettre jeton MCP</button>
            )}
          </div>
        ))}
      </aside>
    </main>
  );
}

function Stats({ stats }: { stats: Bundle["stats"] }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      <Stat label="Inscrits" value={stats.enrolled} />
      <Stat label="Soumissions" value={stats.submitted} />
      <Stat label="Demandes d'aide" value={stats.help_requests} />
      <Stat label="Checklist" value={`${stats.checklist_done}/${stats.checklist_total}`} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function BroadcastForm({ onSubmit }: { onSubmit: (msg: string) => void }) {
  const [msg, setMsg] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (msg.trim()) { onSubmit(msg); setMsg(""); } }}>
      <input className="input mb-2" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={500} placeholder="Message…" />
      <button className="btn btn-primary w-full">Envoyer</button>
    </form>
  );
}

function UploadForm({ onSubmit }: { onSubmit: (f: File, starter: boolean) => void }) {
  const [starter, setStarter] = useState(false);
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) { onSubmit(f, starter); e.target.value = ""; }
        }}
      />
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
        starter
      </label>
    </label>
  );
}

