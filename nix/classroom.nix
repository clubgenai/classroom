{ pkgs, config, lib, classroomSrc, ... }:

let
  apiPort = 8002;
  webPort = 3002;
in
{
  systemd.tmpfiles.rules = [
    "d /var/lib/classroom            0750 classroom classroom -"
    "d /var/lib/classroom/src        0750 classroom classroom -"
    "d /var/lib/classroom/web        0750 classroom classroom -"
    "d /var/lib/classroom/rooms      0750 classroom classroom -"
    "d /var/cache/classroom          0750 classroom classroom -"
  ];

  users.users.classroom = {
    isSystemUser = true;
    group = "classroom";
    extraGroups = [ "mcp-shared" ];
    description = "Classroom service user";
  };
  users.groups.classroom = {};

  # ── FastAPI backend ───────────────────────────────────────────────────────
  systemd.services.classroom-api = {
    description = "ClubGenAI Classroom — FastAPI backend";
    after = [ "network.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      User = "classroom";
      Group = "classroom";
      ExecStartPre = "+${pkgs.bash}/bin/bash -c '\
        cp -r ${classroomSrc}/api/. /var/lib/classroom/src/ && \
        chown -R classroom:classroom /var/lib/classroom/src && \
        rm -rf /var/lib/classroom/venv\
      '";
      ExecStart = "${pkgs.uv}/bin/uv run --project /var/lib/classroom/src classroom";
      WorkingDirectory = "/var/lib/classroom/src";
      Restart = "on-failure";
      RestartSec = "5s";
      EnvironmentFile = config.sops.templates."classroom-env".path;
      Environment = [
        "UV_CACHE_DIR=/var/cache/classroom"
        "UV_DATA_DIR=/var/lib/classroom/uv"
        "UV_PROJECT_ENVIRONMENT=/var/lib/classroom/venv"
        "UV_PYTHON=${pkgs.python3}/bin/python3"
        "UV_PYTHON_DOWNLOADS=never"
        "HOME=/var/lib/classroom"
        "CLASSROOM_DATA_DIR=/var/lib/classroom"
        "CLASSROOM_PORT=${toString apiPort}"
      ];
      ReadWritePaths = [ "/var/lib/classroom" "/var/lib/mcp-shared" ];
      StateDirectory = "classroom classroom/src";
      StateDirectoryMode = "0750";
      CacheDirectory = "classroom";
      CacheDirectoryMode = "0750";
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
    };
  };

  # ── Next.js frontend ──────────────────────────────────────────────────────
  systemd.services.classroom-web = {
    description = "ClubGenAI Classroom — Next.js frontend";
    after = [ "network.target" "classroom-api.service" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      User = "classroom";
      Group = "classroom";
      # Copy source, install deps, build — skip rebuild if source hash unchanged
      ExecStartPre = "+${pkgs.bash}/bin/bash -c '\
        SRC_HASH=${builtins.hashString "sha256" (builtins.toString classroomSrc)}; \
        HASH_FILE=/var/lib/classroom/web/.src-hash; \
        cp -r ${classroomSrc}/web/. /var/lib/classroom/web/; \
        chown -R classroom:classroom /var/lib/classroom/web; \
        if [ ! -f \"$HASH_FILE\" ] || [ \"$(cat $HASH_FILE)\" != \"$SRC_HASH\" ]; then \
          cd /var/lib/classroom/web && \
          ${pkgs.nodejs_22}/bin/npm install --no-audit --no-fund && \
          NEXT_TELEMETRY_DISABLED=1 ${pkgs.nodejs_22}/bin/npm run build && \
          echo \"$SRC_HASH\" > \"$HASH_FILE\"; \
        fi\
      '";
      ExecStart = "${pkgs.nodejs_22}/bin/node /var/lib/classroom/web/.next/standalone/server.js";
      WorkingDirectory = "/var/lib/classroom/web";
      Restart = "on-failure";
      RestartSec = "5s";
      Environment = [
        "PORT=${toString webPort}"
        "HOSTNAME=0.0.0.0"
        "NODE_ENV=production"
        "NEXT_TELEMETRY_DISABLED=1"
        "NEXT_PUBLIC_API_URL=http://127.0.0.1:${toString apiPort}"
        "NEXT_PUBLIC_BASE_PATH=/classroom"
      ];
      ReadWritePaths = [ "/var/lib/classroom" ];
      StateDirectory = "classroom classroom/web";
      StateDirectoryMode = "0750";
    };
  };

  # ── Traefik routes ────────────────────────────────────────────────────────
  # /classroom        → Next.js
  # /classroom/api    → FastAPI (keep prefix — FastAPI handles /api/*)
  # /classroom/ws     → FastAPI websocket
  # /classroom/yws    → FastAPI Yjs websocket
  services.traefik-routes.routes = [
    {
      name = "classroom-api";
      pathPrefix = "/classroom/api";
      backendUrl = "http://host.containers.internal:${toString apiPort}";
      stripPrefix = false;
    }
    {
      name = "classroom-ws";
      pathPrefix = "/classroom/ws";
      backendUrl = "http://host.containers.internal:${toString apiPort}";
      stripPrefix = false;
    }
    {
      name = "classroom-yws";
      pathPrefix = "/classroom/yws";
      backendUrl = "http://host.containers.internal:${toString apiPort}";
      stripPrefix = false;
    }
    {
      name = "classroom-web";
      pathPrefix = "/classroom";
      backendUrl = "http://host.containers.internal:${toString webPort}";
      stripPrefix = false;
    }
  ];
}
