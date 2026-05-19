import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS user (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL CHECK(kind IN ('participant', 'animator')),
    display_name  TEXT NOT NULL,
    github_id     TEXT UNIQUE,        -- animators (from portal JWT)
    github_login  TEXT,
    last_seen_at  REAL,
    created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS room (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    subject       TEXT,
    code          TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL CHECK(status IN ('open', 'started', 'closed')) DEFAULT 'open',
    template_id   INTEGER REFERENCES room_template(id),
    max_participants INTEGER NOT NULL DEFAULT 50,
    started_at    REAL,
    ended_at      REAL,
    created_at    REAL NOT NULL,
    solution      TEXT
);

CREATE TABLE IF NOT EXISTS room_animator (
    room_id    INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    is_owner   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_template (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    animator_id INTEGER NOT NULL REFERENCES user(id),
    payload     TEXT NOT NULL,         -- JSON blob: checklist + resource file list
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_item (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id   INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    label     TEXT NOT NULL,
    UNIQUE(room_id, position)
);

CREATE TABLE IF NOT EXISTS progress (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    room_id    INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    item_id    INTEGER NOT NULL REFERENCES checklist_item(id) ON DELETE CASCADE,
    done_at    REAL NOT NULL,
    UNIQUE(user_id, item_id)
);

CREATE TABLE IF NOT EXISTS enrollment (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    room_id       INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    joined_at     REAL NOT NULL,
    UNIQUE(user_id, room_id)
);

CREATE TABLE IF NOT EXISTS mcp_token (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    enrollment_id INTEGER NOT NULL UNIQUE REFERENCES enrollment(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    scopes       TEXT NOT NULL,
    expires_at   REAL NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   REAL NOT NULL,
    revoked_at   REAL
);

CREATE TABLE IF NOT EXISTS submission (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    room_id      INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    file_path    TEXT NOT NULL,     -- relative to ROOMS_DIR/<room_id>/submissions/
    file_hash    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    version      INTEGER NOT NULL,
    submitted_at REAL NOT NULL,
    UNIQUE(user_id, room_id, filename, version)
);

CREATE TABLE IF NOT EXISTS resource (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES user(id),
    is_starter  INTEGER NOT NULL DEFAULT 0,  -- starter template files
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS help_request (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    room_id     INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    message     TEXT,
    status      TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'resolved')) DEFAULT 'pending',
    position    INTEGER NOT NULL,
    claimed_by  INTEGER REFERENCES user(id),
    claimed_at  REAL,
    resolved_at REAL,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS help_note (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    help_request_id INTEGER NOT NULL REFERENCES help_request(id) ON DELETE CASCADE,
    animator_id     INTEGER NOT NULL REFERENCES user(id),
    content         TEXT NOT NULL,
    created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS room_timer (
    room_id          INTEGER PRIMARY KEY REFERENCES room(id) ON DELETE CASCADE,
    duration_seconds INTEGER NOT NULL,
    started_at       REAL,
    paused_at        REAL,
    elapsed_offset   REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcast_msg (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id   INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES user(id),
    message   TEXT NOT NULL,
    sent_at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS spotlight_event (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id         INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    target_user_id  INTEGER NOT NULL REFERENCES user(id),
    triggered_by    INTEGER NOT NULL REFERENCES user(id),
    anonymous       INTEGER NOT NULL DEFAULT 0,
    content_excerpt TEXT,
    created_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_event (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id    INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES user(id),
    type       TEXT NOT NULL,
    payload    TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enrollment_room  ON enrollment(room_id);
CREATE INDEX IF NOT EXISTS idx_submission_room  ON submission(room_id);
CREATE INDEX IF NOT EXISTS idx_help_room_status ON help_request(room_id, status);
CREATE INDEX IF NOT EXISTS idx_event_room       ON session_event(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_resource_room    ON resource(room_id);
"""

_MIGRATIONS = [
    "ALTER TABLE room ADD COLUMN locked INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE room ADD COLUMN solution TEXT",
]

_init_lock = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(
        config.DB_PATH,
        check_same_thread=False,
        isolation_level=None,
        timeout=30.0,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        conn = _connect()
        try:
            conn.executescript(_SCHEMA)
            # Apply migrations idempotently
            for sql in _MIGRATIONS:
                try:
                    conn.execute(sql)
                    conn.commit()
                except Exception:
                    pass  # column already exists or other benign error
        finally:
            conn.close()
        _initialized = True


@contextmanager
def cursor():
    """Per-call connection. SQLite + WAL handles concurrency fine for this size."""
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()
