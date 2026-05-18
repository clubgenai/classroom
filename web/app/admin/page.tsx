"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, Room } from "@/lib/api";

export default function AdminDashboard() {
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.get<Room[]>("/api/admin/rooms")
      .then(setRooms)
      .catch((e: ApiError) => {
        if (e.status === 401) setNeedsLogin(true);
        else setErr(e.message);
      });
  }, []);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.form("/api/admin/login", { jwt_token: token });
      setNeedsLogin(false);
      const r = await api.get<Room[]>("/api/admin/rooms");
      setRooms(r);
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

  if (needsLogin) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <form onSubmit={login} className="card w-full max-w-md space-y-3">
          <h1 className="text-xl font-semibold">Connexion animateur</h1>
          <p className="text-sm text-muted">Colle ton jeton MCP du portail (l'animateur doit avoir un compte sur le portail GitHub).</p>
          <textarea className="input font-mono text-xs min-h-[120px]" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOiJIUzI1NiI..." required />
          {err && <div className="text-red-400 text-sm">{err}</div>}
          <button className="btn btn-primary w-full">Connexion</button>
          <a href="/" className="block text-sm text-muted text-center">← Espace participant</a>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold">Tableau de bord animateur</h1>
        <button className="btn" onClick={() => api.post("/api/logout").then(() => location.href = "/admin")}>Déconnexion</button>
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
            <a key={r.id} href={`/admin/rooms/${r.id}`} className="card hover:border-accent block">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-sm text-muted">{r.subject || "—"}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-accent">{r.code}</div>
                  <div className="text-xs text-muted">{r.status}</div>
                </div>
              </div>
            </a>
          ))}
        </div>
      </section>

      {err && <div className="text-red-400 mt-4">{err}</div>}
    </main>
  );
}
