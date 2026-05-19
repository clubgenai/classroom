# classroom

Salle de classe virtuelle pour les sessions de formation GenAI de SFEIR. Permet à un animateur de créer des salles, gérer des participants, et proposer des exercices avec un éditeur de code collaboratif en temps réel.

**URL en production** : `http://sfeir-lab.local/classroom`

---

## Stack technique

| Composant | Version | Rôle |
|-----------|---------|------|
| FastAPI | 0.115+ | API REST + WebSocket |
| Python | 3.12 | Runtime backend (image `python:3.12-slim`) |
| uv | dernière | Gestionnaire de paquets Python |
| Next.js | 15.3.9 | Frontend |
| React | 19.1.0 | UI |
| Monaco Editor | 0.50.0 | Éditeur de code in-browser |
| Yjs | 13.6.20 | CRDT collaboration temps réel |
| y-monaco | 0.1.6 | Binding Yjs ↔ Monaco |
| y-websocket | 2.0.4 | Transport Yjs via WebSocket |
| SQLite | — | Base de données |

---

## Architecture

```
sfeir-lab.local/classroom
        │
        ▼
   Traefik
        │
        ├── /classroom/api/*    → classroom-api:8002 (FastAPI REST)
        ├── /classroom/ws/*     → classroom-api:8002 (WebSocket chat/events)
        ├── /classroom/yws/*    → classroom-api:8002 (WebSocket Yjs CRDT)
        └── /classroom/*        → classroom-web:3002 (Next.js)
```

**Collaboration temps réel avec Yjs** :

Yjs est un CRDT (Conflict-free Replicated Data Type) : plusieurs utilisateurs peuvent modifier simultanément le même document sans conflit. Le serveur agit comme relai WebSocket (y-websocket) sans nécessiter de logique de merge côté serveur.

```
Utilisateur A ──WebSocket(/yws)──┐
Utilisateur B ──WebSocket(/yws)──┤── classroom-api (y-websocket relay) ── doc Yjs en mémoire
Animateur    ──WebSocket(/yws)──┘
```

Les modifications de l'éditeur Monaco se propagent instantanément à tous les participants via le protocole Yjs.

---

## Structure du projet

```
classroom/
├── api/                          # Backend FastAPI
│   ├── Dockerfile                # python:3.12-slim + uv
│   ├── pyproject.toml            # Dépendances + script `classroom`
│   └── classroom/                # Package Python
│       ├── __init__.py
│       ├── main.py               # Point d'entrée FastAPI + routes REST (commande `classroom`)
│       ├── auth.py               # Authentification et middleware
│       ├── config.py             # Configuration (variables d'environnement)
│       ├── db.py                 # Modèles SQLite
│       ├── storage.py            # Gestion stockage fichiers/exercices
│       ├── tokens.py             # Gestion tokens JWT
│       ├── ws.py                 # WebSocket handlers (chat/events)
│       └── yjs.py               # WebSocket Yjs CRDT relay
└── web/                          # Frontend Next.js
    ├── Dockerfile                # node:22-alpine, 3 étapes
    ├── package.json
    ├── next.config.js            # Rewrites /api, /ws, /yws → API
    ├── tailwind.config.ts
    ├── tsconfig.json
    ├── app/                      # App Router Next.js
    ├── components/               # Composants React
    └── lib/                      # Utilitaires frontend
```

---

## Développement local

### Prérequis

- Python 3.11+
- `uv` :
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```
- Node.js 22+

### Lancer l'API (classroom-api)

```bash
cd api

# Créer fichier .env
cat > .env << 'EOF'
CLASSROOM_DATA_DIR=/tmp/classroom-data
CLASSROOM_PORT=8002
CLASSROOM_SESSION_SECRET=un_secret_aleatoire_de_64_chars_minimum_ici00000000000000000000
MCP_JWT_SECRET=un_autre_secret_aleatoire_64_chars_minimum_ici000000000000000000
EOF

# Créer le dossier de données
mkdir -p /tmp/classroom-data

# Créer et activer l'environnement virtuel
uv venv && source .venv/bin/activate

# Installer les dépendances
uv pip install -e .

# Lancer (via le script défini dans pyproject.toml)
classroom
```

API disponible sur `http://localhost:8002`  
Docs Swagger : `http://localhost:8002/docs`

### Lancer le frontend (classroom-web)

```bash
cd web

cat > .env.local << 'EOF'
NEXT_PUBLIC_BASE_PATH=
NEXT_PUBLIC_API_URL=http://localhost:8002
EOF

npm install
npm run dev
# Accessible sur http://localhost:3000 (mode dev)
```

### Tester la collaboration temps réel

Ouvrir deux onglets sur la même salle Classroom. Les modifications dans l'éditeur Monaco se synchronisent instantanément via Yjs WebSocket (`/yws`).

---

## Variables d'environnement

### classroom-api (runtime)

| Variable | Requis | Exemple | Description |
|----------|--------|---------|-------------|
| `CLASSROOM_SESSION_SECRET` | Oui | `openssl rand -hex 64` | Clé chiffrement sessions participants |
| `MCP_JWT_SECRET` | Oui | `openssl rand -hex 64` | Secret JWT partagé avec Portal et MCP Server |
| `PORTAL_SESSION_SECRET` | Oui (prod) | `openssl rand -hex 64` | Secret JWT Portal pour auth animateurs — vide = animateurs non authentifiés |
| `CLASSROOM_DATA_DIR` | Non | `/data` | Dossier stockage données SQLite + fichiers |
| `CLASSROOM_PORT` | Non | `8002` | Port d'écoute API |
| `CLASSROOM_BASE_URL` | Non | `http://sfeir-lab.local/classroom` | URL publique de base (pour génération de liens) |
| `PORTAL_URL` | Non | `http://sfeir-lab.local/portal` | URL Portal pour redirections auth animateur |
| `MCP_JWT_ISSUER` | Non | `sfeir-lab-classroom` | Issuer des tokens JWT émis |
| `MCP_JWT_AUDIENCE` | Non | `mcp-server` | Audience des tokens JWT émis |

### classroom-web (build-time Docker ARG)

| Variable | Valeur prod | Description |
|----------|-------------|-------------|
| `NEXT_PUBLIC_BASE_PATH` | `/classroom` | Préfixe chemin Next.js (build-time ARG) |
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8002` | URL interne API Classroom |

---

## Gestion des secrets sur le serveur

Les secrets sont gérés via SOPS dans `nix-sfeir-lab`.

Fichier concerné : `secrets/classroom.yaml`

```bash
cd /path/to/nix-sfeir-lab
sops secrets/classroom.yaml
```

Voir [nix-sfeir-lab — Gestion des secrets avec SOPS](https://github.com/clubgenai/nix-sfeir-lab#gestion-des-secrets-avec-sops) pour le guide complet step-by-step.

---

## Livraison manuelle des images Docker

Ce repo produit **deux images** : `classroom-api` et `classroom-web`.

### Prérequis

- Docker installé
- Personal Access Token GitHub avec scope `write:packages`
  - Créer sur : https://github.com/settings/tokens → "Generate new token (classic)" → cocher `write:packages`

### Authentification ghcr.io

```bash
export GHCR_TOKEN="votre_token_github"
echo $GHCR_TOKEN | docker login ghcr.io -u votre_username_github --password-stdin
```

Résultat attendu : `Login Succeeded`

### Choisir un tag

```bash
export TAG=$(git rev-parse --short HEAD)
echo "Tag : $TAG"
```

### Builder et pusher classroom-api

```bash
cd api

docker build \
  -t ghcr.io/clubgenai/classroom-api:$TAG \
  -t ghcr.io/clubgenai/classroom-api:latest \
  .

# Vérifier localement
docker run --rm -p 8002:8002 \
  -e CLASSROOM_SESSION_SECRET=testsecret32charslongatleasthere00 \
  -e MCP_JWT_SECRET=testsecret32charslongatleasthere00 \
  -v /tmp/classroom-test:/data \
  ghcr.io/clubgenai/classroom-api:$TAG

# Pusher
docker push ghcr.io/clubgenai/classroom-api:$TAG
docker push ghcr.io/clubgenai/classroom-api:latest
```

### Builder et pusher classroom-web

```bash
cd web

docker build \
  --build-arg NEXT_PUBLIC_BASE_PATH=/classroom \
  --build-arg NEXT_PUBLIC_API_URL=http://127.0.0.1:8002 \
  -t ghcr.io/clubgenai/classroom-web:$TAG \
  -t ghcr.io/clubgenai/classroom-web:latest \
  .

# Pusher
docker push ghcr.io/clubgenai/classroom-web:$TAG
docker push ghcr.io/clubgenai/classroom-web:latest
```

### Appliquer sur le serveur

```bash
ssh sfeir@sfeir-lab.local

podman pull ghcr.io/clubgenai/classroom-api:latest
podman pull ghcr.io/clubgenai/classroom-web:latest

systemctl --user restart podman-classroom-api
systemctl --user restart podman-classroom-web

# Vérifier
systemctl --user status podman-classroom-api
systemctl --user status podman-classroom-web
```

---

## CI/CD automatique

`.github/workflows/docker.yml` : 2 jobs parallèles triggés sur push `main`.

| Job | Image | Tags |
|-----|-------|------|
| `classroom-api` | `ghcr.io/clubgenai/classroom-api` | `latest` + SHA complet 40 chars (CI) / SHA court 7 chars (manuel) |
| `classroom-web` | `ghcr.io/clubgenai/classroom-web` | `latest` + SHA complet 40 chars (CI) / SHA court 7 chars (manuel) |

---

## Déploiement sur le serveur

Module NixOS : `modules/classroom.nix` dans [nix-sfeir-lab](https://github.com/clubgenai/nix-sfeir-lab)

Voir [nix-sfeir-lab — Déploiement NixOS](https://github.com/clubgenai/nix-sfeir-lab#déploiement-nixos) pour le guide complet.
