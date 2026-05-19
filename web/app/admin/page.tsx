"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, Room } from "@/lib/api";

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
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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

  useEffect(() => { loadRooms(); }, []);

  const deleteRoom = async (room: Room) => {
    if (!confirm(`Supprimer la salle «${room.name}» ? Cette action est irréversible.`)) return;
    try {
      await api.delete(`/api/admin/rooms/${room.id}`);
      loadRooms();
    } catch (e: any) {
      setErr(e.message);
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

      <section className="card mb-6">
        <h2 className="text-lg font-semibold mb-4">Nouvelle salle</h2>
        <form onSubmit={createRoom} className="grid gap-3">
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
          <button className="btn btn-primary" disabled={creating}>{creating ? "…" : "Créer"}</button>
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
