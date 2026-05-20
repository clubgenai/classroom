import os
from pathlib import Path

SESSION_SECRET = os.environ.get("CLASSROOM_SESSION_SECRET", "dev-only-change-me")

# Shared with the portal: same MCP_JWT_SECRET so tokens validate on mcp-server.
MCP_JWT_SECRET = os.environ.get("MCP_JWT_SECRET", "")
MCP_JWT_ISSUER = os.environ.get("MCP_JWT_ISSUER", "sfeir-lab-classroom")
MCP_JWT_AUDIENCE = os.environ.get("MCP_JWT_AUDIENCE", "mcp-server")
MCP_JWT_ALG = "HS256"

# Animators auth via portal JWT (same secret).
PORTAL_SESSION_SECRET = os.environ.get("PORTAL_SESSION_SECRET", "")
PORTAL_URL = os.environ.get("PORTAL_URL", "http://sfeir-lab.local/portal")

# Data root — SQLite + uploaded files live here.
DATA_DIR = Path(os.environ.get("CLASSROOM_DATA_DIR", "/var/lib/classroom"))
DB_PATH = DATA_DIR / "classroom.db"
ROOMS_DIR = DATA_DIR / "rooms"

PUBLIC_BASE_URL = os.environ.get("CLASSROOM_BASE_URL", "http://sfeir-lab.local/classroom")

# Hard caps.
MAX_ROOM_TTL_SECONDS = 4 * 3600
MAX_PARTICIPANTS_PER_ROOM = 100
ROOM_CODE_LENGTH = 6
HELP_REQUEST_COOLDOWN_SECONDS = 30
BROADCAST_COOLDOWN_SECONDS = 5

PARTICIPANT_SCOPES = ["files:read", "files:write"]

# Coder integration (optional — if CODER_ADMIN_TOKEN is empty, workspace endpoints return 503)
CODER_URL = os.environ.get("CODER_URL", "")
CODER_ADMIN_TOKEN = os.environ.get("CODER_ADMIN_TOKEN", "")
CODER_TEMPLATE_ID = os.environ.get("CODER_TEMPLATE_ID", "")
CODER_ORG_ID = os.environ.get("CODER_ORG_ID", "")

DATA_DIR.mkdir(parents=True, exist_ok=True)
ROOMS_DIR.mkdir(parents=True, exist_ok=True)
