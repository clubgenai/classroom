"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";

export default function Landing() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = await api.form<{ user: any; room_id: number }>("/api/join", {
        display_name: name.trim(),
        code: code.trim().toUpperCase(),
      });
      router.push(`/room/${res.room_id}`);
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <h1 className="text-xl font-semibold mb-6">Rejoindre une salle</h1>
        <form onSubmit={join} className="space-y-4">
          <div>
            <label className="label">Votre nom</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Camille" />
          </div>
          <div>
            <label className="label">Code de la salle</label>
            <input className="input uppercase tracking-widest text-center font-mono" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} required placeholder="AB12CD" />
          </div>
          {err && <div className="text-red-400 text-sm">{err}</div>}
          <button className="btn btn-primary w-full" disabled={busy}>{busy ? "…" : "Entrer"}</button>
        </form>
        <div className="mt-6 pt-4 border-t border-border text-center">
          <a href="/admin" className="text-muted text-sm hover:text-text">Espace animateur →</a>
        </div>
      </div>
    </main>
  );
}
