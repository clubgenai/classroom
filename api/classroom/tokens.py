import secrets
import time

import jwt

from . import config, storage


def issue_participant_token(
    enrollment_id: int, user_id: int, room_id: int, ttl_seconds: int
) -> tuple[str, dict]:
    """
    Returns (raw_jwt, stored_row).
    JWT carries room_id + scopes. mcp-server validates signature + checks expiry.
    """
    ttl = min(ttl_seconds, config.MAX_ROOM_TTL_SECONDS)
    now = int(time.time())
    exp = now + ttl
    jti = secrets.token_urlsafe(12)

    payload = {
        "iss": config.MCP_JWT_ISSUER,
        "aud": config.MCP_JWT_AUDIENCE,
        "sub": f"classroom-participant-{user_id}",
        "scopes": " ".join(config.PARTICIPANT_SCOPES),
        "room_id": room_id,
        "enrollment_id": enrollment_id,
        "iat": now,
        "exp": exp,
        "jti": jti,
    }
    token = jwt.encode(payload, config.MCP_JWT_SECRET, algorithm=config.MCP_JWT_ALG)
    stored = storage.create_mcp_token(
        enrollment_id=enrollment_id,
        raw_token=token,
        scopes=config.PARTICIPANT_SCOPES,
        expires_at=float(exp),
    )
    return token, stored
