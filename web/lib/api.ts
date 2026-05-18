/* Thin fetch wrapper. credentials: 'include' so the FastAPI session cookie sticks. */

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text || res.statusText);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body?: FormData | object) => {
    const init: RequestInit = { method: "POST" };
    if (body instanceof FormData) init.body = body;
    else if (body) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return req<T>(path, init);
  },
  form: <T>(path: string, fields: Record<string, string | number | boolean | Blob>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Blob) fd.append(k, v);
      else fd.append(k, String(v));
    }
    return req<T>(path, { method: "POST", body: fd });
  },
};

export type User = {
  id: number;
  kind: "participant" | "animator";
  display_name: string;
  github_id?: string | null;
  github_login?: string | null;
  last_seen_at?: number | null;
};

export type Room = {
  id: number;
  name: string;
  subject: string;
  code: string;
  status: "open" | "started" | "closed";
  max_participants: number;
  started_at?: number | null;
  ended_at?: number | null;
  created_at: number;
};

export type ChecklistItem = { id: number; room_id: number; position: number; label: string };
export type Resource = { id: number; room_id: number; filename: string; is_starter: number; size_bytes: number; created_at: number };
export type Submission = { id: number; user_id: number; room_id: number; filename: string; version: number; submitted_at: number; size_bytes: number; display_name?: string };
export type HelpRequest = { id: number; user_id: number; room_id: number; message: string; status: string; position: number; claimed_by?: number | null; display_name?: string; created_at: number };
export type Enrollment = { id: number; user_id: number; room_id: number; joined_at: number; display_name: string; last_seen_at: number | null };
export type Timer = { room_id: number; duration_seconds: number; started_at: number | null; paused_at: number | null; elapsed_offset: number } | null;
