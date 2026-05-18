"use client";

import { useEffect, useState } from "react";
import type { Timer as TimerType } from "@/lib/api";

export default function Timer({ timer }: { timer: TimerType }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!timer) { setRemaining(null); return; }
    const tick = () => {
      const now = Date.now() / 1000;
      const elapsed = timer.elapsed_offset + (timer.started_at ? now - timer.started_at : 0);
      setRemaining(Math.max(0, timer.duration_seconds - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timer]);

  if (remaining === null) return <span className="font-mono text-yellow-400">--:--</span>;
  const m = Math.floor(remaining / 60).toString().padStart(2, "0");
  const s = Math.floor(remaining % 60).toString().padStart(2, "0");
  return <span className="font-mono text-yellow-400 text-lg">{m}:{s}</span>;
}
