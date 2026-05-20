terraform {
  required_providers {
    coder  = { source = "coder/coder"           }
    docker = { source = "kreuzwerker/docker"     }
  }
}

data "coder_workspace"       "me" {}
data "coder_workspace_owner" "me" {}

# ── Agent ─────────────────────────────────────────────────────────────────────

resource "coder_agent" "main" {
  arch = "amd64"
  os   = "linux"

  startup_script = <<-EOT
    code-server \
      --bind-addr 0.0.0.0:8080 \
      --auth none \
      --disable-telemetry \
      --disable-update-check \
      /home/coder/workspace \
      </dev/null >/tmp/code-server.log 2>&1 &
    disown
  EOT
}

# VS Code in browser via code-server
resource "coder_app" "code_server" {
  agent_id     = coder_agent.main.id
  slug         = "code"
  display_name = "VS Code"
  url          = "http://localhost:8080"
  icon         = "/icon/code.svg"
  subdomain    = false
  share        = "owner"
}

# ── Volume workspace ──────────────────────────────────────────────────────────

resource "docker_volume" "workspace" {
  name = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}"
}

# ── Réseau isolé par workspace ────────────────────────────────────────────────

resource "docker_network" "workspace" {
  name   = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}"
  driver = "bridge"
}

# ── Container ─────────────────────────────────────────────────────────────────

resource "docker_container" "workspace" {
  count = data.coder_workspace.me.start_count
  name  = "coder-${data.coder_workspace_owner.me.name}-${data.coder_workspace.me.name}"
  image = "ghcr.io/clubgenai/coder-tp-claude:latest"

  # Non-root
  user = "1000:1000"

  env = [
    "CODER_AGENT_TOKEN=${coder_agent.main.token}",
    "CODER_AGENT_URL=http://host.docker.internal:3100",
  ]

  volumes {
    volume_name    = docker_volume.workspace.name
    container_path = "/home/coder/workspace"
  }

  networks_advanced {
    name = docker_network.workspace.name
  }

  # Agent doit joindre le serveur Coder sur l'hôte
  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }
}
