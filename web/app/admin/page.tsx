"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, Room } from "@/lib/api";

interface Template {
  id: number;
  name: string;
  animator_id: number;
  created_at: number;
  payload: {
    subject: string;
    max_participants: number;
    checklist_items: string[];
  };
}

async function ensureAnimatorAuth(): Promise<boolean> {
  // Try to get animator token from portal and exchange it
  try {
    const res = await fetch("/portal/api/animator-token", { credentials: "include" });
    if (!res.ok) return false;
    const { token } = await res.json();
    const fd = new FormData();
    fd.append("jwt_token", token);
    const loginRes = await fetch("/classroom/api/admin/login", {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    return loginRes.ok;
  } catch {
    return false;
  }
}

export default function AdminDashboard() {
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const loadRooms = () => {
    api.get<Room[]>("/api/admin/rooms")
      .then(setRooms)
      .catch(async (e: ApiError) => {
        if (e.status === 401) {
          const ok = await ensureAnimatorAuth();
          if (ok) {
            api.get<Room[]>("/api/admin/rooms").then(setRooms).catch(() => {
              window.location.href = "/portal?next=/classroom/admin";
            });
          } else {
            window.location.href = "/portal?next=/classroom/admin";
          }
        } else {
          setErr(e.message);
        }
      });
  };

  const loadTemplates = () => {
    api.get<Template[]>("/api/admin/templates")
      .then(setTemplates)
      .catch(() => setTemplates([]));
  };

  useEffect(() => {
    loadRooms();
    loadTemplates();
  }, []);

  const deleteRoom = async (room: Room) => {
    if (!confirm(`Supprimer la salle «${room.name}» ? Cette action est irréversible.`)) return;
    try {
      await api.delete(`/api/admin/rooms/${room.id}`);
      loadRooms();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const applyTemplate = (tpl: Template) => {
    const form = formRef.current;
    if (!form) return;
    (form.elements.namedItem("name") as HTMLInputElement).value = tpl.name;
    (form.elements.namedItem("subject") as HTMLInputElement).value = tpl.payload.subject ?? "";
    (form.elements.namedItem("max_participants") as HTMLInputElement).value = String(tpl.payload.max_participants ?? 50);
    (form.elements.namedItem("checklist") as HTMLTextAreaElement).value = (tpl.payload.checklist_items ?? []).join("\n");
  };

  const deleteTemplate = async (tpl: Template) => {
    if (!confirm(`Supprimer le template «${tpl.name}» ?`)) return;
    try {
      await api.delete(`/api/admin/templates/${tpl.id}`);
      loadTemplates();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const saveAsTemplate = async () => {
    const form = formRef.current;
    if (!form) return;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    if (!name) { setErr("Le nom est requis pour créer un template"); return; }
    const subject = (form.elements.namedItem("subject") as HTMLInputElement).value.trim();
    const maxP = parseInt((form.elements.namedItem("max_participants") as HTMLInputElement).value) || 50;
    const checklistRaw = (form.elements.namedItem("checklist") as HTMLTextAreaElement).value;
    const checklistItems = checklistRaw.split("\n").map((l) => l.trim()).filter(Boolean);
    setSavingTemplate(true);
    try {
      await api.post("/api/admin/templates", {
        name,
        subject,
        max_participants: maxP,
        checklist_items: checklistItems,
      });
      loadTemplates();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSavingTemplate(false);
    }
  };

  const createRoom = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setCreating(true);
    try {
      const room = await api.post<Room>("/api/admin/rooms", fd as any);
      router.push(`/admin/rooms/${room.id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally { setCreating(false); }
  };

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Tableau de bord animateur</h1>
        <button className="btn" onClick={() => api.post("/api/logout").then(() => location.href = "/classroom/admin")}>Déconnexion</button>
      </div>

      {templates.length > 0 && (
        <section className="card mb-6">
          <h2 className="text-lg font-semibold mb-3">Templates</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {templates.map((tpl) => (
              <div key={tpl.id} className="border border-border rounded p-3 hover:border-accent cursor-pointer flex justify-between items-start gap-2">
                <button
                  className="flex-1 text-left"
                  onClick={() => applyTemplate(tpl)}
                  title="Cliquer pour pré-remplir le formulaire"
                >
                  <div className="font-medium text-sm">{tpl.name}</div>
                  {tpl.payload.subject && (
                    <div className="text-xs text-muted mt-0.5">{tpl.payload.subject}</div>
                  )}
                </button>
                <button
                  className="text-muted hover:text-red-400 text-xs shrink-0"
                  onClick={() => deleteTemplate(tpl)}
                  title="Supprimer ce template"
                >✕</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card mb-6">
        <h2 className="text-lg font-semibold mb-4">Nouvelle salle</h2>
        <form ref={formRef} onSubmit={createRoom} className="grid gap-3">
          <div>
            <label className="label">Nom</label>
            <input className="input" name="name" required maxLength={120} />
          </div>
          <div>
            <label className="label">Sujet</label>
            <input className="input" name="subject" maxLength={200} />
          </div>
          <div>
            <label className="label">Participants max</label>
            <input className="input" type="number" name="max_participants" defaultValue={50} min={1} max={100} />
          </div>
          <div>
            <label className="label">Checklist (une ligne par item)</label>
            <textarea className="input min-h-[100px]" name="checklist" placeholder="Lire l'énoncé&#10;Cloner le repo&#10;Implémenter la fonction X" />
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={creating}>{creating ? "…" : "Créer"}</button>
            <button
              type="button"
              className="btn"
              disabled={savingTemplate}
              onClick={saveAsTemplate}
              title="Sauvegarder les valeurs actuelles comme template"
            >{savingTemplate ? "…" : "Sauvegarder comme template"}</button>
          </div>
        </form>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Mes salles</h2>
        {rooms === null && <div className="text-muted">Chargement…</div>}
        {rooms && rooms.length === 0 && <div className="text-muted">Aucune salle</div>}
        <div className="grid gap-2">
          {rooms?.map((r) => (
            <div key={r.id} className="card hover:border-accent flex justify-between items-center">
              <a href={`/classroom/admin/rooms/${r.id}`} className="flex-1 block">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-sm text-muted">{r.subject || "—"}</div>
                  </div>
                  <div className="text-right mr-4">
                    <div className="font-mono text-accent">{r.code}</div>
                    <div className="text-xs text-muted">{r.status}</div>
                  </div>
                </div>
              </a>
              <button
                className="btn btn-danger text-sm shrink-0"
                onClick={(e) => { e.preventDefault(); deleteRoom(r); }}
              >🗑</button>
            </div>
          ))}
        </div>
      </section>

      {err && <div className="text-red-400 mt-4">{err}</div>}
    </main>
  );
}
