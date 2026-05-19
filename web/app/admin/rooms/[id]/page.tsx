"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
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
  const [showEdit, setShowEdit] = useState(false);
  const [diffEnrollment, setDiffEnrollment] = useState<Enrollment | null>(null);
  const [showReport, setShowReport] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await api.get<Bundle>(`/api/admin/rooms/${roomId}`);
      setData(d);
      setTimer(d.timer);
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          const res = await fetch("/portal/api/animator-token", { credentials: "include" });
          if (res.ok) {
            const { token } = await res.json();
            const fd = new FormData();
            fd.append("jwt_token", token);
            const loginRes = await fetch("/classroom/api/admin/login", { method: "POST", credentials: "include", body: fd });
            if (loginRes.ok) { reload(); return; }
          }
        } catch {}
        window.location.href = `/portal?next=/classroom/admin/rooms/${roomId}`;
        return;
      }
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, [roomId]);

  useEffect(() => { reload(); }, [reload]);

  useRoomSocket(roomId, "animator", (ev: any) => {
    if (ev.type === "timer") setTimer(ev.timer);
    if (["help_requested", "help_claimed", "help_resolved", "submission", "progress", "resource_added", "room_locked", "room_unlocked"].includes(ev.type)) {
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
  const resetTimer = async () => {
    await api.post(`/api/admin/rooms/${roomId}/timer`, { action: "set", duration_seconds: data?.timer?.duration_seconds ?? 0 });
    reload();
  };
  const stopTimer = async () => {
    await api.post(`/api/admin/rooms/${roomId}/timer`, { action: "set", duration_seconds: 0 });
    reload();
  };

  const startRoom = () => api.post(`/api/admin/rooms/${roomId}/start`).then(reload);
  const closeRoom = () => { if (confirm("Fermer la salle ?")) api.post(`/api/admin/rooms/${roomId}/close`).then(reload); };

  const editRoom = async (fields: { name: string; subject: string; max_participants: number; checklist_items: string }) => {
    try {
      await api.put(`/api/admin/rooms/${roomId}`, fields);
      toast.push("Salle mise à jour", "success");
      setShowEdit(false);
      reload();
    } catch (e: any) { toast.push(e.message, "error"); }
  };

  const toggleLock = async () => {
    const locked = data.room.locked;
    try {
      await api.post(`/api/admin/rooms/${roomId}/${locked ? "unlock" : "lock"}`);
      toast.push(locked ? "Salle déverrouillée" : "Salle verrouillée", "success");
      reload();
    } catch (e: any) { toast.push(e.message, "error"); }
  };

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

  const removeParticipant = async (e: Enrollment) => {
    if (!confirm(`Retirer ${e.display_name} de la salle ?`)) return;
    try {
      await api.delete(`/api/admin/rooms/${roomId}/enrollments/${e.id}`);
      reload();
    } catch (err: any) { toast.push(err.message, "error"); }
  };

  const removeResource = async (r: Resource) => {
    if (!confirm(`Supprimer la ressource ${r.filename} ?`)) return;
    try {
      await api.delete(`/api/admin/rooms/${roomId}/resources/${r.id}`);
      reload();
    } catch (err: any) { toast.push(err.message, "error"); }
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
            <button
              className="btn text-xs"
              title={data.room.locked ? "Déverrouiller" : "Verrouiller"}
              onClick={toggleLock}
            >{data.room.locked ? "🔒" : "🔓"}</button>
            <button className="btn text-xs" onClick={() => setShowEdit(true)}>Modifier</button>
            {data.room.status === "open" && <button className="btn btn-primary" onClick={startRoom}>Démarrer</button>}
            {data.room.status !== "closed" && <button className="btn btn-danger" onClick={closeRoom}>Fermer</button>}
            <button className="btn text-xs" onClick={() => setShowReport(true)}>Rapport</button>
            <a href={`/classroom/api/admin/rooms/${roomId}/export`} className="btn text-xs" download>Export ZIP</a>
            <a href="/classroom/admin" className="btn">←</a>
          </div>
        </header>
        {showEdit && (
          <EditModal
            room={data.room}
            checklist={data.checklist}
            onClose={() => setShowEdit(false)}
            onSubmit={editRoom}
          />
        )}

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
              <button className="btn" onClick={resetTimer} title="Reset">↺</button>
              <button className="btn" onClick={stopTimer}>■ Stop</button>
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
              <div key={r.id} className="flex justify-between items-center bg-bg p-2 rounded text-sm">
                <span>{r.is_starter ? "⭐ " : ""}{r.filename}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted">{Math.ceil(r.size_bytes / 1024)} kB</span>
                  <button className="btn btn-danger text-xs" onClick={() => removeResource(r)}>✕</button>
                </div>
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
            <div className="flex justify-between items-center">
              <div className="text-sm font-medium">{e.display_name}</div>
              <div className="flex gap-1">
                {data.submissions.some((s) => s.user_id === e.user_id) && (
                  <button className="btn text-xs" onClick={() => setDiffEnrollment(e)}>Diff</button>
                )}
                <button className="btn btn-danger text-xs" onClick={() => removeParticipant(e)}>✕</button>
              </div>
            </div>
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

      {diffEnrollment && (
        <DiffModal
          roomId={roomId}
          enrollment={diffEnrollment}
          onClose={() => setDiffEnrollment(null)}
          onSolutionSaved={() => { toast.push("Solution enregistrée", "success"); }}
        />
      )}

      {showReport && (
        <ReportModal roomId={roomId} onClose={() => setShowReport(false)} />
      )}
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

function EditModal({
  room,
  checklist,
  onClose,
  onSubmit,
}: {
  room: Room;
  checklist: ChecklistItem[];
  onClose: () => void;
  onSubmit: (fields: { name: string; subject: string; max_participants: number; checklist_items: string }) => void;
}) {
  const [name, setName] = useState(room.name);
  const [subject, setSubject] = useState(room.subject ?? "");
  const [maxParticipants, setMaxParticipants] = useState(room.max_participants);
  const [checklistItems, setChecklistItems] = useState(
    checklist.map((c) => c.label).join("\n")
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, subject, max_participants: maxParticipants, checklist_items: checklistItems });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Modifier la salle</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="label">Nom</label>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </div>
          <div>
            <label className="label">Sujet</label>
            <input className="input w-full" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </div>
          <div>
            <label className="label">Participants max</label>
            <input className="input w-full" type="number" min={1} max={200} value={maxParticipants} onChange={(e) => setMaxParticipants(parseInt(e.target.value, 10))} required />
          </div>
          <div>
            <label className="label">Checklist (une ligne par item)</label>
            <textarea className="input w-full h-28 resize-y" value={checklistItems} onChange={(e) => setChecklistItems(e.target.value)} />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button type="button" className="btn" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn btn-primary">Enregistrer</button>
          </div>
        </form>
      </div>
    </div>
  );
}

type DiffData = { submitted_code: string | null; solution: string | null };

function DiffModal({
  roomId,
  enrollment,
  onClose,
  onSolutionSaved,
}: {
  roomId: number;
  enrollment: Enrollment;
  onClose: () => void;
  onSolutionSaved: () => void;
}) {
  const [diff, setDiff] = useState<DiffData | null>(null);
  const [solution, setSolution] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<DiffData>(`/api/admin/rooms/${roomId}/participants/${enrollment.id}/diff`).then((d) => {
      setDiff(d);
      setSolution(d.solution ?? "");
    });
  }, [roomId, enrollment.id]);

  const saveSolution = async () => {
    setSaving(true);
    try {
      await api.post(`/api/admin/rooms/${roomId}/solution`, { code: solution });
      onSolutionSaved();
      setDiff((prev) => prev ? { ...prev, solution } : prev);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg p-6 w-[90vw] max-w-5xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">Diff — {enrollment.display_name}</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        {!diff ? (
          <div className="text-muted text-sm">Chargement…</div>
        ) : (
          <div className="flex gap-4 flex-1 overflow-hidden min-h-0">
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="text-xs font-semibold text-muted mb-1">Soumission du participant</div>
              <div className="flex-1 overflow-auto bg-bg rounded p-2 font-mono text-xs leading-5">
                {diff.submitted_code == null ? (
                  <span className="text-muted">Aucune soumission</span>
                ) : (
                  diff.submitted_code.split("\n").map((line, i) => {
                    const solLine = (diff.solution ?? "").split("\n")[i] ?? "";
                    const differs = diff.solution != null && line !== solLine;
                    return (
                      <div key={i} className={`px-1 rounded ${differs ? "bg-red-900/40" : ""}`}>
                        {line || " "}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="text-xs font-semibold text-muted mb-1">Solution attendue</div>
              <textarea
                className="flex-1 bg-bg rounded p-2 font-mono text-xs leading-5 resize-none border border-border focus:outline-none focus:border-accent"
                value={solution}
                onChange={(e) => setSolution(e.target.value)}
                placeholder="Collez ou saisissez la solution ici…"
              />
              <button
                className="btn btn-primary mt-2 text-xs"
                onClick={saveSolution}
                disabled={saving}
              >
                {saving ? "Enregistrement…" : "Enregistrer la solution"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type ReportData = {
  room: { name: string; subject: string; created_at: number };
  participants_total: number;
  checklist_completion_pct: number;
  submissions_count: number;
  help_requests_total: number;
  help_requests_resolved: number;
  per_participant: {
    name: string;
    checklist_done: number;
    checklist_total: number;
    submitted: boolean;
    help_requests: number;
  }[];
};

function ReportModal({ roomId, onClose }: { roomId: number; onClose: () => void }) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<ReportData>(`/api/admin/rooms/${roomId}/report`)
      .then(setReport)
      .catch((e: any) => setErr(e.message ?? String(e)));
  }, [roomId]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg p-6 w-[90vw] max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold text-lg">Rapport de session</h2>
          <button className="btn" onClick={onClose}>✕</button>
        </div>

        {err && <div className="text-red-400 text-sm">{err}</div>}
        {!report && !err && <div className="text-muted text-sm">Chargement…</div>}

        {report && (
          <div className="flex flex-col gap-4 overflow-auto">
            <div className="grid grid-cols-4 gap-3">
              <Stat label="Participants" value={report.participants_total} />
              <Stat label="Checklist %" value={`${report.checklist_completion_pct}%`} />
              <Stat label="Soumissions" value={report.submissions_count} />
              <Stat label="Aide résolue" value={`${report.help_requests_resolved}/${report.help_requests_total}`} />
            </div>

            <div className="overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left text-muted text-xs border-b border-border">
                    <th className="py-2 pr-3">Participant</th>
                    <th className="py-2 pr-3">Checklist</th>
                    <th className="py-2 pr-3">Soumis</th>
                    <th className="py-2">Aide</th>
                  </tr>
                </thead>
                <tbody>
                  {report.per_participant.map((p, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 font-medium">{p.name}</td>
                      <td className="py-2 pr-3 text-muted">{p.checklist_done}/{p.checklist_total}</td>
                      <td className="py-2 pr-3">
                        {p.submitted
                          ? <span className="text-green-400 font-semibold">oui</span>
                          : <span className="text-muted">non</span>}
                      </td>
                      <td className="py-2">{p.help_requests}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

