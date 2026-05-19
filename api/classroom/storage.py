import hashlib
import json
import secrets
import string
import time
from pathlib import Path
from typing import Any, Optional

from . import config, db


# ── User ──────────────────────────────────────────────────────────────────────

def create_participant(display_name: str) -> dict:
    now = time.time()
    with db.cursor() as conn:
        cur = conn.execute(
            "INSERT INTO user (kind, display_name, created_at, last_seen_at) "
            "VALUES ('participant', ?, ?, ?)",
            (display_name.strip()[:60], now, now),
        )
        uid = cur.lastrowid
        row = conn.execute("SELECT * FROM user WHERE id=?", (uid,)).fetchone()
    return dict(row)


def upsert_animator(github_id: str, github_login: str, name: str) -> dict:
    now = time.time()
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT * FROM user WHERE github_id=?", (github_id,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE user SET display_name=?, github_login=?, last_seen_at=? WHERE id=?",
                (name, github_login, now, row["id"]),
            )
            row = conn.execute("SELECT * FROM user WHERE id=?", (row["id"],)).fetchone()
        else:
            cur = conn.execute(
                "INSERT INTO user (kind, display_name, github_id, github_login, created_at, last_seen_at) "
                "VALUES ('animator', ?, ?, ?, ?, ?)",
                (name, github_id, github_login, now, now),
            )
            row = conn.execute("SELECT * FROM user WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def get_user(user_id: int) -> Optional[dict]:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM user WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def touch_user_seen(user_id: int) -> None:
    with db.cursor() as conn:
        conn.execute("UPDATE user SET last_seen_at=? WHERE id=?", (time.time(), user_id))


# ── Room ──────────────────────────────────────────────────────────────────────

def _gen_room_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(config.ROOM_CODE_LENGTH))


def create_room(
    name: str,
    subject: str,
    animator_id: int,
    max_participants: int = 50,
    checklist: Optional[list[str]] = None,
) -> dict:
    now = time.time()
    with db.cursor() as conn:
        # Retry to avoid code collision
        for _ in range(8):
            code = _gen_room_code()
            try:
                cur = conn.execute(
                    "INSERT INTO room (name, subject, code, max_participants, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (name, subject, code, max_participants, now),
                )
                room_id = cur.lastrowid
                break
            except Exception:
                continue
        else:
            raise RuntimeError("Could not allocate room code")

        conn.execute(
            "INSERT INTO room_animator (room_id, user_id, is_owner) VALUES (?, ?, 1)",
            (room_id, animator_id),
        )
        for i, label in enumerate(checklist or []):
            conn.execute(
                "INSERT INTO checklist_item (room_id, position, label) VALUES (?, ?, ?)",
                (room_id, i, label.strip()[:200]),
            )
        room = dict(conn.execute("SELECT * FROM room WHERE id=?", (room_id,)).fetchone())
    (config.ROOMS_DIR / str(room_id) / "submissions").mkdir(parents=True, exist_ok=True)
    (config.ROOMS_DIR / str(room_id) / "resources").mkdir(parents=True, exist_ok=True)
    return room


def get_room(room_id: int) -> Optional[dict]:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM room WHERE id=?", (room_id,)).fetchone()
    return dict(row) if row else None


def get_room_by_code(code: str) -> Optional[dict]:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM room WHERE code=?", (code.upper(),)).fetchone()
    return dict(row) if row else None


def list_open_rooms() -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT * FROM room WHERE status IN ('open','started') ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def list_animator_rooms(animator_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT r.* FROM room r "
            "JOIN room_animator ra ON ra.room_id = r.id "
            "WHERE ra.user_id = ? ORDER BY r.created_at DESC",
            (animator_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def room_animators(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT u.*, ra.is_owner FROM user u "
            "JOIN room_animator ra ON ra.user_id = u.id "
            "WHERE ra.room_id = ?",
            (room_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def is_animator_of(room_id: int, user_id: int) -> bool:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT 1 FROM room_animator WHERE room_id=? AND user_id=?",
            (room_id, user_id),
        ).fetchone()
    return row is not None


def add_animator(room_id: int, user_id: int) -> None:
    with db.cursor() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO room_animator (room_id, user_id, is_owner) VALUES (?, ?, 0)",
            (room_id, user_id),
        )


def start_room(room_id: int) -> None:
    with db.cursor() as conn:
        conn.execute(
            "UPDATE room SET status='started', started_at=? WHERE id=? AND status='open'",
            (time.time(), room_id),
        )


def close_room(room_id: int) -> None:
    with db.cursor() as conn:
        conn.execute(
            "UPDATE room SET status='closed', ended_at=? WHERE id=? AND status != 'closed'",
            (time.time(), room_id),
        )


# ── Enrollment ────────────────────────────────────────────────────────────────

def enroll_participant(user_id: int, room_id: int) -> dict:
    now = time.time()
    with db.cursor() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO enrollment (user_id, room_id, joined_at) VALUES (?, ?, ?)",
            (user_id, room_id, now),
        )
        row = conn.execute(
            "SELECT * FROM enrollment WHERE user_id=? AND room_id=?",
            (user_id, room_id),
        ).fetchone()
    return dict(row)


def list_enrollments(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT e.*, u.display_name, u.last_seen_at "
            "FROM enrollment e JOIN user u ON u.id = e.user_id "
            "WHERE e.room_id=? ORDER BY e.joined_at ASC",
            (room_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_enrollment(enrollment_id: int) -> Optional[dict]:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM enrollment WHERE id=?", (enrollment_id,)).fetchone()
    return dict(row) if row else None


# ── MCP tokens ────────────────────────────────────────────────────────────────

def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def create_mcp_token(
    enrollment_id: int, raw_token: str, scopes: list[str], expires_at: float
) -> dict:
    now = time.time()
    with db.cursor() as conn:
        conn.execute("DELETE FROM mcp_token WHERE enrollment_id=?", (enrollment_id,))
        cur = conn.execute(
            "INSERT INTO mcp_token (enrollment_id, token_hash, scopes, expires_at, active, created_at) "
            "VALUES (?, ?, ?, ?, 1, ?)",
            (enrollment_id, _sha(raw_token), ",".join(scopes), expires_at, now),
        )
        row = conn.execute("SELECT * FROM mcp_token WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def revoke_mcp_token(enrollment_id: int) -> None:
    with db.cursor() as conn:
        conn.execute(
            "UPDATE mcp_token SET active=0, revoked_at=? WHERE enrollment_id=?",
            (time.time(), enrollment_id),
        )


def get_mcp_token_for_enrollment(enrollment_id: int) -> Optional[dict]:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT * FROM mcp_token WHERE enrollment_id=?", (enrollment_id,)
        ).fetchone()
    return dict(row) if row else None


# ── Submissions (files on disk, metadata in DB) ───────────────────────────────

def submit_file(user_id: int, room_id: int, filename: str, data: bytes) -> dict:
    safe = "".join(c for c in filename if c.isalnum() or c in "._-")[:80] or "file.txt"
    file_hash = hashlib.sha256(data).hexdigest()
    target_dir = config.ROOMS_DIR / str(room_id) / "submissions" / str(user_id)
    target_dir.mkdir(parents=True, exist_ok=True)

    now = time.time()
    with db.cursor() as conn:
        v = conn.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM submission "
            "WHERE user_id=? AND room_id=? AND filename=?",
            (user_id, room_id, safe),
        ).fetchone()[0]

        rel_path = f"{user_id}/{safe}.v{v}"
        full_path = target_dir / f"{safe}.v{v}"
        full_path.write_bytes(data)

        cur = conn.execute(
            "INSERT INTO submission (user_id, room_id, filename, file_path, file_hash, size_bytes, version, submitted_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, room_id, safe, rel_path, file_hash, len(data), v, now),
        )
        row = conn.execute("SELECT * FROM submission WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_submissions(room_id: int, user_id: Optional[int] = None) -> list[dict]:
    with db.cursor() as conn:
        if user_id:
            rows = conn.execute(
                "SELECT s.*, u.display_name FROM submission s JOIN user u ON u.id=s.user_id "
                "WHERE s.room_id=? AND s.user_id=? ORDER BY s.submitted_at DESC",
                (room_id, user_id),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT s.*, u.display_name FROM submission s JOIN user u ON u.id=s.user_id "
                "WHERE s.room_id=? ORDER BY s.submitted_at DESC",
                (room_id,),
            ).fetchall()
    return [dict(r) for r in rows]


def submission_disk_path(submission: dict) -> Path:
    return config.ROOMS_DIR / str(submission["room_id"]) / "submissions" / submission["file_path"]


# ── Resources ─────────────────────────────────────────────────────────────────

def upload_resource(
    room_id: int, filename: str, data: bytes, uploaded_by: int, is_starter: bool = False
) -> dict:
    safe = "".join(c for c in filename if c.isalnum() or c in "._-")[:80] or "file.txt"
    target_dir = config.ROOMS_DIR / str(room_id) / "resources"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_dir.joinpath(safe).write_bytes(data)
    now = time.time()
    with db.cursor() as conn:
        cur = conn.execute(
            "INSERT INTO resource (room_id, filename, file_path, size_bytes, uploaded_by, is_starter, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room_id, safe, safe, len(data), uploaded_by, 1 if is_starter else 0, now),
        )
        row = conn.execute("SELECT * FROM resource WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_resources(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT * FROM resource WHERE room_id=? ORDER BY is_starter DESC, created_at ASC",
            (room_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def resource_disk_path(resource: dict) -> Path:
    return config.ROOMS_DIR / str(resource["room_id"]) / "resources" / resource["file_path"]


# ── Help requests ─────────────────────────────────────────────────────────────

def create_help_request(user_id: int, room_id: int, message: str) -> dict:
    now = time.time()
    with db.cursor() as conn:
        pos = conn.execute(
            "SELECT COUNT(*) FROM help_request WHERE room_id=? AND status IN ('pending','in_progress')",
            (room_id,),
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO help_request (user_id, room_id, message, position, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, room_id, message[:500], pos, now),
        )
        row = conn.execute("SELECT * FROM help_request WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_help_requests(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT h.*, u.display_name FROM help_request h JOIN user u ON u.id=h.user_id "
            "WHERE h.room_id=? AND h.status != 'resolved' "
            "ORDER BY h.position ASC",
            (room_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def claim_help_request(help_id: int, animator_id: int) -> None:
    now = time.time()
    with db.cursor() as conn:
        conn.execute(
            "UPDATE help_request SET status='in_progress', claimed_by=?, claimed_at=? "
            "WHERE id=? AND claimed_by IS NULL",
            (animator_id, now, help_id),
        )


def resolve_help_request(help_id: int) -> None:
    with db.cursor() as conn:
        conn.execute(
            "UPDATE help_request SET status='resolved', resolved_at=? WHERE id=?",
            (time.time(), help_id),
        )


def add_help_note(help_id: int, animator_id: int, content: str) -> dict:
    now = time.time()
    with db.cursor() as conn:
        cur = conn.execute(
            "INSERT INTO help_note (help_request_id, animator_id, content, created_at) "
            "VALUES (?, ?, ?, ?)",
            (help_id, animator_id, content[:1000], now),
        )
        row = conn.execute("SELECT * FROM help_note WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def last_help_request_at(user_id: int, room_id: int) -> Optional[float]:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT MAX(created_at) FROM help_request WHERE user_id=? AND room_id=?",
            (user_id, room_id),
        ).fetchone()
    return row[0]


# ── Progress / checklist ──────────────────────────────────────────────────────

def list_checklist(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT * FROM checklist_item WHERE room_id=? ORDER BY position",
            (room_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def mark_progress(user_id: int, room_id: int, item_id: int, done: bool) -> None:
    with db.cursor() as conn:
        if done:
            conn.execute(
                "INSERT OR IGNORE INTO progress (user_id, room_id, item_id, done_at) VALUES (?, ?, ?, ?)",
                (user_id, room_id, item_id, time.time()),
            )
        else:
            conn.execute(
                "DELETE FROM progress WHERE user_id=? AND item_id=?",
                (user_id, item_id),
            )


def list_progress(user_id: int, room_id: int) -> list[int]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT item_id FROM progress WHERE user_id=? AND room_id=?",
            (user_id, room_id),
        ).fetchall()
    return [r[0] for r in rows]


def progress_summary(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT u.id AS user_id, u.display_name, "
            "       COUNT(DISTINCT p.item_id) AS done_count, "
            "       (SELECT COUNT(*) FROM checklist_item WHERE room_id=?) AS total "
            "FROM enrollment e JOIN user u ON u.id=e.user_id "
            "LEFT JOIN progress p ON p.user_id=u.id AND p.room_id=e.room_id "
            "WHERE e.room_id=? GROUP BY u.id",
            (room_id, room_id),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Timer ─────────────────────────────────────────────────────────────────────

def set_timer(room_id: int, duration_seconds: int) -> dict:
    with db.cursor() as conn:
        conn.execute(
            "INSERT INTO room_timer (room_id, duration_seconds) VALUES (?, ?) "
            "ON CONFLICT(room_id) DO UPDATE SET duration_seconds=excluded.duration_seconds, "
            "started_at=NULL, paused_at=NULL, elapsed_offset=0",
            (room_id, duration_seconds),
        )
        row = conn.execute("SELECT * FROM room_timer WHERE room_id=?", (room_id,)).fetchone()
    return dict(row)


def start_timer(room_id: int) -> dict:
    now = time.time()
    with db.cursor() as conn:
        conn.execute(
            "UPDATE room_timer SET started_at=COALESCE(started_at, ?), paused_at=NULL WHERE room_id=?",
            (now, room_id),
        )
        row = conn.execute("SELECT * FROM room_timer WHERE room_id=?", (room_id,)).fetchone()
    return dict(row) if row else None


def pause_timer(room_id: int) -> dict:
    now = time.time()
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM room_timer WHERE room_id=?", (room_id,)).fetchone()
        if not row or row["started_at"] is None or row["paused_at"] is not None:
            return dict(row) if row else None
        new_offset = row["elapsed_offset"] + (now - row["started_at"])
        conn.execute(
            "UPDATE room_timer SET paused_at=?, elapsed_offset=?, started_at=NULL WHERE room_id=?",
            (now, new_offset, room_id),
        )
        row = conn.execute("SELECT * FROM room_timer WHERE room_id=?", (room_id,)).fetchone()
    return dict(row)


def get_timer(room_id: int) -> Optional[dict]:
    with db.cursor() as conn:
        row = conn.execute("SELECT * FROM room_timer WHERE room_id=?", (room_id,)).fetchone()
    return dict(row) if row else None


# ── Broadcasts ────────────────────────────────────────────────────────────────

def create_broadcast(room_id: int, sender_id: int, message: str) -> dict:
    now = time.time()
    with db.cursor() as conn:
        cur = conn.execute(
            "INSERT INTO broadcast_msg (room_id, sender_id, message, sent_at) VALUES (?, ?, ?, ?)",
            (room_id, sender_id, message[:500], now),
        )
        row = conn.execute("SELECT * FROM broadcast_msg WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def last_broadcast_at(sender_id: int, room_id: int) -> Optional[float]:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT MAX(sent_at) FROM broadcast_msg WHERE sender_id=? AND room_id=?",
            (sender_id, room_id),
        ).fetchone()
    return row[0]


# ── Spotlight ─────────────────────────────────────────────────────────────────

def create_spotlight(
    room_id: int, target_user_id: int, triggered_by: int, anonymous: bool, content_excerpt: str
) -> dict:
    now = time.time()
    with db.cursor() as conn:
        cur = conn.execute(
            "INSERT INTO spotlight_event (room_id, target_user_id, triggered_by, anonymous, content_excerpt, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (room_id, target_user_id, triggered_by, 1 if anonymous else 0, content_excerpt[:2000], now),
        )
        row = conn.execute("SELECT * FROM spotlight_event WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


# ── Session events (audit + replay) ───────────────────────────────────────────

def log_event(room_id: int, event_type: str, user_id: Optional[int], payload: Any = None) -> None:
    with db.cursor() as conn:
        conn.execute(
            "INSERT INTO session_event (room_id, user_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (room_id, user_id, event_type, json.dumps(payload) if payload is not None else None, time.time()),
        )


def list_events(room_id: int) -> list[dict]:
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT * FROM session_event WHERE room_id=? ORDER BY created_at ASC",
            (room_id,),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Stats ─────────────────────────────────────────────────────────────────────

def delete_room(room_id: int) -> None:
    with db.cursor() as conn:
        conn.execute("DELETE FROM submission WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM resource WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM help_request WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM progress WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM enrollment WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM room_animator WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM checklist_item WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM room_timer WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM broadcast_msg WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM spotlight_event WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM session_event WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM room WHERE id=?", (room_id,))


def delete_enrollment(room_id: int, enrollment_id: int) -> None:
    with db.cursor() as conn:
        conn.execute("DELETE FROM mcp_token WHERE enrollment_id=?", (enrollment_id,))
        conn.execute("DELETE FROM progress WHERE user_id=(SELECT user_id FROM enrollment WHERE id=?) AND room_id=?", (enrollment_id, room_id))
        conn.execute("DELETE FROM enrollment WHERE id=? AND room_id=?", (enrollment_id, room_id))


def delete_resource(room_id: int, resource_id: int) -> None:
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT * FROM resource WHERE id=? AND room_id=?", (resource_id, room_id)
        ).fetchone()
        if row:
            try:
                resource_disk_path(dict(row)).unlink(missing_ok=True)
            except Exception:
                pass
            conn.execute("DELETE FROM resource WHERE id=? AND room_id=?", (resource_id, room_id))


def room_stats(room_id: int) -> dict:
    with db.cursor() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM enrollment WHERE room_id=?", (room_id,)
        ).fetchone()[0]
        submitted = conn.execute(
            "SELECT COUNT(DISTINCT user_id) FROM submission WHERE room_id=?", (room_id,)
        ).fetchone()[0]
        help_count = conn.execute(
            "SELECT COUNT(*) FROM help_request WHERE room_id=?", (room_id,)
        ).fetchone()[0]
        cl_total = conn.execute(
            "SELECT COUNT(*) FROM checklist_item WHERE room_id=?", (room_id,)
        ).fetchone()[0]
        cl_done = conn.execute(
            "SELECT COUNT(*) FROM progress WHERE room_id=?", (room_id,)
        ).fetchone()[0]
    return {
        "enrolled": total,
        "submitted": submitted,
        "help_requests": help_count,
        "checklist_total": cl_total,
        "checklist_done": cl_done,
    }
