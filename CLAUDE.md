# CLAUDE.md — NetMap · Infra Topology Explorer

Plan d'implémentation complet pour Claude Code.
Lis ce fichier en entier avant de commencer. Chaque phase est indépendante et testable.

---

## Vue d'ensemble du projet

```
netmap/
├── CLAUDE.md                  ← ce fichier
├── docker-compose.yml         ← stack complète
├── docker-compose.dev.yml     ← override dev (hot-reload, ports exposés)
├── .env.example
│
├── agent/                     ← Binaire Go, déployé dans chaque VM/VPS
│   ├── main.go
│   ├── go.mod
│   ├── Dockerfile
│   └── deploy/
│       ├── systemd.service    ← template service systemd
│       └── install.sh         ← script d'installation one-liner
│
├── scanner/                   ← Service Go dédié ARP + nmap (tourne sur l'hôte réseau)
│   ├── main.go
│   ├── go.mod
│   └── Dockerfile
│
├── server/                    ← Backend Fastify (Node 20)
│   ├── src/
│   │   ├── index.js           ← entrypoint
│   │   ├── db.js              ← SQLite schema + prepared statements
│   │   ├── auth.js            ← JWT + gestion users + tokens agents
│   │   ├── routes/
│   │   │   ├── auth.js        ← POST /api/auth/login, /refresh, /logout
│   │   │   ├── agent.js       ← POST /api/agent/report
│   │   │   ├── topology.js    ← GET /api/topology, /api/stats
│   │   │   ├── scanner.js     ← POST /api/scanner/report, GET /api/scanner/trigger
│   │   │   └── admin.js       ← CRUD agents tokens, users (auth required)
│   │   └── ws.js              ← WebSocket broadcast
│   ├── package.json
│   └── Dockerfile
│
└── frontend/                  ← React 19 + Vite + D3
    ├── src/
    │   ├── main.jsx
    │   ├── App.jsx
    │   ├── pages/
    │   │   ├── Login.jsx      ← page de connexion
    │   │   └── Dashboard.jsx  ← topologie principale
    │   ├── components/
    │   │   ├── TopologyGraph.jsx
    │   │   ├── DetailPanel.jsx
    │   │   ├── NodeInspector.jsx
    │   │   └── ScannerPanel.jsx
    │   ├── hooks/
    │   │   ├── useTopology.js
    │   │   ├── useWebSocket.js
    │   │   └── useAuth.js
    │   └── lib/
    │       ├── api.js         ← wrapper fetch avec JWT refresh automatique
    │       └── nodeConfig.js  ← couleurs, symboles, tailles par type
    ├── package.json
    └── Dockerfile
```

---

## Stack technique

| Composant    | Technologie                                      | Raison                                     |
|--------------|--------------------------------------------------|--------------------------------------------|
| Agent        | Go 1.22, stdlib only                            | binaire unique, cross-compile, 0 dep       |
| Scanner      | Go 1.22 + `github.com/google/gopacket`          | ARP raw, parse nmap XML                    |
| Backend      | Node 20, Fastify v4, better-sqlite3             | léger, WebSocket natif, WAL mode           |
| Auth         | JWT (access 15min + refresh 7j) + bcrypt        | stateless, sécurisé, refresh transparent   |
| DB           | SQLite 3 (WAL)                                  | zéro infrastructure, backup trivial        |
| Frontend     | React 19, Vite, D3 v7, TailwindCSS             | force-graph, performant                    |
| Reverse proxy| Traefik v2 (ou Nginx si préféré)                | TLS auto, routing, headers sécurité        |

---

## Phase 1 — Infrastructure Docker

### Objectif
Stack complète opérationnelle avec hot-reload en dev, images optimisées en prod.

### 1.1 `docker-compose.yml` (production)

```yaml
version: "3.9"

services:

  # ── Reverse proxy ──────────────────────────────────────────────────────────
  traefik:
    image: traefik:v2.11
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.tlschallenge=true
      - --certificatesresolvers.le.acme.email=${ACME_EMAIL}
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-certs:/letsencrypt
    restart: unless-stopped

  # ── Backend ────────────────────────────────────────────────────────────────
  server:
    build: ./server
    environment:
      - NODE_ENV=production
      - PORT=3000
      - DB_PATH=/data/netmap.db
      - JWT_SECRET=${JWT_SECRET}          # openssl rand -hex 32
      - JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
      - AGENT_TOKEN_SALT=${AGENT_TOKEN_SALT}
      - PROXMOX_HOST=${PROXMOX_HOST}
      - PROXMOX_USER=${PROXMOX_USER:-root@pam}
      - PROXMOX_PASS=${PROXMOX_PASS}
      - PROXMOX_POLL=${PROXMOX_POLL:-60}
      - NODE_TLS_REJECT_UNAUTHORIZED=${PROXMOX_TLS:-1}
    volumes:
      - netmap-data:/data
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.netmap-api.rule=Host(`${DOMAIN}`) && PathPrefix(`/api`,`/ws`)"
      - "traefik.http.routers.netmap-api.entrypoints=websecure"
      - "traefik.http.routers.netmap-api.tls.certresolver=le"
      - "traefik.http.services.netmap-api.loadbalancer.server.port=3000"
      # Security headers
      - "traefik.http.middlewares.netmap-headers.headers.stsSeconds=31536000"
      - "traefik.http.middlewares.netmap-headers.headers.contentTypeNosniff=true"
      - "traefik.http.middlewares.netmap-headers.headers.frameDeny=true"
    restart: unless-stopped
    depends_on:
      - traefik

  # ── Frontend ───────────────────────────────────────────────────────────────
  frontend:
    build:
      context: ./frontend
      args:
        - VITE_API_URL=https://${DOMAIN}
        - VITE_WS_URL=wss://${DOMAIN}/ws
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.netmap-front.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.netmap-front.entrypoints=websecure"
      - "traefik.http.routers.netmap-front.tls.certresolver=le"
      - "traefik.http.services.netmap-front.loadbalancer.server.port=80"
    restart: unless-stopped

  # ── Scanner (réseau local uniquement) ─────────────────────────────────────
  scanner:
    build: ./scanner
    network_mode: host            # OBLIGATOIRE pour ARP raw socket
    cap_add:
      - NET_RAW
      - NET_ADMIN
    environment:
      - NETMAP_SERVER=http://server:3000
      - NETMAP_TOKEN=${SCANNER_TOKEN}
      - SCAN_NETWORKS=${SCAN_NETWORKS:-192.168.1.0/24}
      - SCAN_INTERVAL=${SCAN_INTERVAL:-300}    # secondes entre chaque scan complet
      - NMAP_ARGS=${NMAP_ARGS:--sV --top-ports 50 -O --osscan-limit -T4}
    depends_on:
      - server
    restart: unless-stopped

volumes:
  netmap-data:
  traefik-certs:
```

### 1.2 `docker-compose.dev.yml` (override dev)

```yaml
version: "3.9"

services:
  server:
    build:
      context: ./server
      target: dev
    volumes:
      - ./server/src:/app/src  # hot-reload avec --watch
    environment:
      - NODE_ENV=development
      - LOG_LEVEL=debug
    ports:
      - "3000:3000"            # accès direct sans Traefik
    labels: []                 # désactiver Traefik en dev

  frontend:
    build:
      context: ./frontend
      target: dev
    volumes:
      - ./frontend/src:/app/src
    environment:
      - VITE_API_URL=http://localhost:3000
      - VITE_WS_URL=ws://localhost:3000/ws
    ports:
      - "5173:5173"
    labels: []

  scanner:
    environment:
      - NETMAP_SERVER=http://localhost:3000
      - LOG_LEVEL=debug
```

Usage :
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### 1.3 Dockerfiles

**`agent/Dockerfile`** — multi-stage, image finale ~10 MB :
```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o netmap-agent .

FROM alpine:3.19
RUN apk add --no-cache iproute2 net-tools samba-client
COPY --from=builder /app/netmap-agent /usr/local/bin/
ENTRYPOINT ["netmap-agent"]
```

**`scanner/Dockerfile`** — nécessite nmap + libpcap :
```dockerfile
FROM golang:1.22-alpine AS builder
RUN apk add --no-cache libpcap-dev gcc musl-dev
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -ldflags="-s -w" -o netmap-scanner .

FROM alpine:3.19
RUN apk add --no-cache nmap nmap-scripts libpcap
COPY --from=builder /app/netmap-scanner /usr/local/bin/
ENTRYPOINT ["netmap-scanner"]
```

**`server/Dockerfile`** — multi-stage Node :
```dockerfile
FROM node:20-alpine AS base
WORKDIR /app

FROM base AS dev
COPY package*.json ./
RUN npm ci
COPY src ./src
CMD ["node", "--watch", "src/index.js"]

FROM base AS builder
COPY package*.json ./
RUN npm ci --omit=dev

FROM base AS prod
COPY --from=builder /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
USER node
CMD ["node", "src/index.js"]
```

**`frontend/Dockerfile`** — build Vite → Nginx :
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
ARG VITE_API_URL
ARG VITE_WS_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS dev
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "dev", "--", "--host"]

FROM nginx:1.25-alpine AS prod
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

---

## Phase 2 — Authentification

### Modèle de sécurité

```
┌─────────────┐         ┌──────────────────────────────┐
│  Humain     │  JWT    │  Routes protégées             │
│  (browser)  │◄───────►│  GET /api/topology            │
└─────────────┘         │  GET /api/stats               │
                         │  GET /api/admin/*             │
┌─────────────┐  Bearer │                              │
│  Agent Go   │◄───────►│  POST /api/agent/report      │
│  (VM/VPS)   │  token  │  (token statique par agent)  │
└─────────────┘         │                              │
┌─────────────┐  Bearer │                              │
│  Scanner    │◄───────►│  POST /api/scanner/report    │
└─────────────┘  token  └──────────────────────────────┘
```

### 2.1 Schema DB auth (`server/src/db.js`)

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE,
  password    TEXT    NOT NULL,   -- bcrypt hash, cost=12
  role        TEXT    NOT NULL DEFAULT 'viewer',  -- 'admin' | 'viewer'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login  INTEGER
);

CREATE TABLE agent_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,           -- "vm-prod-01", "vps-ovh"
  token_hash  TEXT    NOT NULL UNIQUE,    -- SHA-256 du token brut
  scope       TEXT    NOT NULL DEFAULT 'agent',  -- 'agent' | 'scanner'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE refresh_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked     INTEGER NOT NULL DEFAULT 0
);
```

### 2.2 Routes auth (`server/src/routes/auth.js`)

```
POST /api/auth/login
  Body: { username, password }
  → 200: { accessToken (15min), refreshToken (7j, httpOnly cookie) }
  → 401: { error: "invalid credentials" }

POST /api/auth/refresh
  Cookie: refreshToken
  → 200: { accessToken }
  → 401: token invalide ou expiré (→ redirect login)

POST /api/auth/logout
  Cookie: refreshToken
  → révoque le refresh token en DB, clear cookie
  → 204

GET /api/auth/me
  Header: Authorization: Bearer <accessToken>
  → 200: { id, username, role }
```

### 2.3 Middleware auth (`server/src/auth.js`)

Deux middlewares Fastify :

**`verifyJWT`** — pour les routes frontend :
```javascript
// Vérifie Authorization: Bearer <accessToken>
// Attache req.user = { id, username, role }
// 401 si absent ou expiré → le frontend fait un /refresh automatique
```

**`verifyAgentToken`** — pour les agents et scanner :
```javascript
// Vérifie Authorization: Bearer <token>
// Hash SHA-256 le token, compare avec agent_tokens.token_hash
// Met à jour last_seen
// 401 si inconnu ou révoqué
// Attache req.agent = { id, name, scope }
// Vérifie que scope correspond à la route ('agent' vs 'scanner')
```

### 2.4 Hook axios/fetch côté frontend (`frontend/src/lib/api.js`)

```javascript
// Wrapper autour de fetch qui :
// 1. Ajoute Authorization: Bearer <accessToken> depuis le state React/localStorage
// 2. Sur 401 → appelle POST /api/auth/refresh
//    - succès → retry la requête originale avec le nouveau token
//    - échec → redirect /login
// 3. Expose : api.get(), api.post(), api.ws()
```

### 2.5 Page Login (`frontend/src/pages/Login.jsx`)

UI cyberpunk cohérente avec le reste :
- Champ username + password
- Animation de scan sur submit
- Message d'erreur inline (pas de toast)
- Pas de "forgot password" (outil interne)
- `useAuth` hook → stocke accessToken en mémoire (pas localStorage), refreshToken en httpOnly cookie

### 2.6 Gestion des tokens agents (admin)

Route `GET /api/admin/tokens` → liste des tokens avec last_seen
Route `POST /api/admin/tokens` → crée un token, retourne le token brut **une seule fois**
Route `DELETE /api/admin/tokens/:id` → révocation immédiate

Affichage dans le frontend : panneau admin accessible depuis le header (role admin uniquement).

### 2.7 Initialisation

Au premier démarrage du serveur, si la table `users` est vide :
```javascript
// Créer un user admin par défaut
// Username: admin
// Password: lu depuis env NETMAP_ADMIN_PASS, ou généré aléatoirement et loggué
console.warn("⚠ Mot de passe admin initial :", generatedPassword);
```

---

## Phase 3 — Scanner ARP/nmap

### Architecture

```
Scanner Go (network_mode: host)
    │
    ├── 1. ARP sweep (gopacket, raw socket)
    │      → découvre les hôtes actifs + MACs en ~2s
    │
    ├── 2. Pour chaque hôte trouvé :
    │      nmap -sV --top-ports 50 -O -T4 <ip>
    │      → parse le XML nmap pour ports + OS
    │
    ├── 3. Heuristiques device type
    │      OUI MAC → fabricant → type estimé
    │      ports ouverts → type estimé
    │
    └── 4. Push POST /api/scanner/report (token Bearer)
```

### 3.1 `scanner/main.go` — structure principale

```go
type ScanResult struct {
    ScannedAt   time.Time      `json:"scanned_at"`
    Network     string         `json:"network"`
    Hosts       []ScannedHost  `json:"hosts"`
}

type ScannedHost struct {
    IP          string         `json:"ip"`
    MAC         string         `json:"mac"`
    Vendor      string         `json:"vendor"`      // depuis OUI lookup
    Hostname    string         `json:"hostname"`    // reverse DNS
    OS          string         `json:"os"`          // nmap OS detection
    DeviceType  string         `json:"device_type"` // heuristique
    OpenPorts   []Port         `json:"open_ports"`
    HasAgent    bool           `json:"has_agent"`   // rempli par le serveur
}
```

### 3.2 ARP sweep

```go
// Utiliser github.com/google/gopacket
// 1. Ouvrir le handle pcap sur l'interface (ex: eth0)
// 2. Envoyer un ARP "who-has <ip>" pour chaque IP du sous-réseau
// 3. Écouter les ARP replies pendant ~3s (timeout configurable)
// 4. Dédupliquer par IP, garder le MAC le plus récent

// Pour chaque réseau dans SCAN_NETWORKS (CSV) :
//   ParseCIDR → itérer toutes les IPs sauf réseau + broadcast
```

### 3.3 nmap integration

```go
// Lancer nmap avec output XML (-oX -)
// Parser le XML avec encoding/xml
// Extraire :
//   - ports ouverts + service + version
//   - OS guess (osmatch[0].name si accuracy > 70%)
//   - hostname (hostnames.hostname)

// Concurrence : limiter à MaxConcurrentScans (défaut: 10) goroutines
// Timeout par host : 30s
```

### 3.4 Heuristiques device type

```go
// Règles dans l'ordre de priorité :
//
// 1. Ports signatures :
//    - 8006 ouvert → proxmox
//    - 5000/5001 → nas (Synology DSM)
//    - 9090/9100 → monitoring (Prometheus/Node Exporter)
//    - 1883 → iot (MQTT broker)
//    - 22 only → linux_generic
//    - 3389 → windows
//
// 2. OUI MAC (charger un fichier oui.txt compact) :
//    - VMware/QEMU prefixes → vm
//    - Synology → nas
//    - Ubiquiti → network
//    - TP-Link/Cisco → switch/router
//    - Raspberry Pi Foundation → rpi
//
// 3. OS nmap string :
//    - "Windows" → windows
//    - "Linux" → linux_generic
//    - "Cisco IOS" → switch
//    - "FreeBSD/pfSense" → firewall
//
// 4. Fallback → "unknown"
```

### 3.5 Route serveur `POST /api/scanner/report`

```javascript
// 1. Vérifier token scope === 'scanner'
// 2. Pour chaque host dans report.hosts :
//    a. Upsert dans scanned_hosts (SQLite)
//    b. Vérifier si un agent existe avec cette IP → hasAgent = true
//    c. Si hasAgent : ne pas créer de nœud dupliqué, juste enrichir
//       l'agent avec les données nmap (vendor, deviceType, nmapOS)
// 3. Broadcast WebSocket "scanner_updated"
```

### 3.6 Nouveau schema DB

```sql
CREATE TABLE scanned_hosts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ip           TEXT    NOT NULL UNIQUE,
  mac          TEXT,
  vendor       TEXT,
  hostname     TEXT,
  os           TEXT,
  device_type  TEXT,
  open_ports   TEXT,   -- JSON array
  has_agent    INTEGER NOT NULL DEFAULT 0,
  last_seen    INTEGER NOT NULL,
  first_seen   INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 3.7 Déclenchement manuel depuis le frontend

```
GET /api/scanner/trigger   (auth JWT, role admin)
→ 202 Accepted (le scanner démarre un cycle immédiatement)
→ WebSocket broadcast "scan_started" { network, estimated_duration }
→ WebSocket broadcast "scan_progress" { done, total, current_ip }
→ WebSocket broadcast "scanner_updated" { hosts_found }
```

Bouton "Scan now" dans le header du frontend, avec progress bar live.

---

## Phase 4 — Intégration frontend

### 4.1 Nouveaux types de nœuds

Ajouter à `nodeConfig.js` :
```javascript
scanned: { color: "#10b981", symbol: "?", r: 18 },  // vert émeraude, inconnu
iot:     { color: "#f59e0b", symbol: "IO", r: 16 },
router:  { color: "#ef4444", symbol: "RT", r: 26 },
```

Les nœuds "scanned" sans agent ont un contour pointillé plus fin, et une icône `?`.

### 4.2 Badge "no agent"

Sur les nœuds `scanned` sans agent : petit badge rouge en bas à droite avec "NO AGENT".
Au clic → le panel détail affiche les données nmap + un bouton "Copy install command" qui génère la commande d'installation de l'agent.

### 4.3 ScannerPanel component

Barre en haut du canvas (apparaît pendant un scan) :
```
◉ SCANNING 192.168.1.0/24  ████████░░░░  47/254  ETA ~18s
```

### 4.4 Filtres par type (sidebar gauche)

Checkboxes pour masquer/afficher des types :
- ☑ Proxmox (1)
- ☑ VMs / LXC (4)
- ☑ Agents (3)
- ☑ Containers (8)
- ☑ Scanned / No agent (5)

---

## Phase 5 — Script d'installation agent

### `agent/deploy/install.sh`

Script one-liner sécurisé :

```bash
#!/usr/bin/env bash
# Usage: curl -fsSL https://netmap.ton-domaine.local/install.sh | \
#   NETMAP_SERVER=https://netmap.ton-domaine.local \
#   NETMAP_TOKEN=<token> \
#   bash

set -euo pipefail

NETMAP_SERVER="${NETMAP_SERVER:?NETMAP_SERVER requis}"
NETMAP_TOKEN="${NETMAP_TOKEN:?NETMAP_TOKEN requis}"
INSTALL_DIR="/usr/local/bin"
SERVICE_NAME="netmap-agent"

# Détecter l'arch
ARCH=$(uname -m)
case $ARCH in
  x86_64)  ARCH=amd64  ;;
  aarch64) ARCH=arm64  ;;
  armv7l)  ARCH=arm    ;;
  *) echo "Arch $ARCH non supportée" && exit 1 ;;
esac

echo "[netmap] Téléchargement de l'agent ($ARCH)..."
curl -fsSL "$NETMAP_SERVER/downloads/netmap-agent-linux-$ARCH" \
  -o "$INSTALL_DIR/netmap-agent"
chmod +x "$INSTALL_DIR/netmap-agent"

echo "[netmap] Installation du service systemd..."
cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=NetMap Agent
After=network-online.target
Wants=network-online.target

[Service]
Environment=NETMAP_SERVER=$NETMAP_SERVER
Environment=NETMAP_TOKEN=$NETMAP_TOKEN
Environment=NETMAP_INTERVAL=30s
ExecStart=$INSTALL_DIR/netmap-agent
Restart=always
RestartSec=15
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
echo "[netmap] Agent installé et démarré ✓"
systemctl status "$SERVICE_NAME" --no-pager
```

Le frontend sert ce script statiquement depuis le backend (`GET /install.sh`).

### `agent/deploy/systemd.service`

Template complet avec variables commentées pour installation manuelle.

---

## Phase 6 — Fichiers de config

### `.env.example`
```bash
# Domaine public (ou IP locale si homelab fermé)
DOMAIN=netmap.homelab.local
ACME_EMAIL=romain@example.com

# Secrets (générer avec : openssl rand -hex 32)
JWT_SECRET=
JWT_REFRESH_SECRET=
AGENT_TOKEN_SALT=

# Admin initial
NETMAP_ADMIN_PASS=changeme-at-first-boot

# Scanner
SCANNER_TOKEN=           # généré via l'interface admin
SCAN_NETWORKS=192.168.1.0/24,192.168.2.0/24
SCAN_INTERVAL=300
NMAP_ARGS=-sV --top-ports 50 -O --osscan-limit -T4

# Proxmox
PROXMOX_HOST=192.168.1.200:8006
PROXMOX_USER=root@pam
PROXMOX_PASS=
PROXMOX_POLL=60
PROXMOX_TLS=0            # 0 = ignorer cert auto-signé (homelab)
```

---

## Ordre d'implémentation recommandé

```
Phase 1a  →  Dockerfiles (agent, scanner, server, frontend)
Phase 1b  →  docker-compose.yml (prod) + .dev.yml
Phase 2a  →  DB schema auth + middleware JWT + verifyAgentToken
Phase 2b  →  Routes /auth/* + page Login frontend
Phase 2c  →  api.js avec refresh automatique + useAuth hook
Phase 2d  →  Page admin tokens (CRUD)
Phase 3a  →  Scanner ARP (gopacket)
Phase 3b  →  Scanner nmap (exec + parse XML)
Phase 3c  →  Heuristiques device type + OUI lookup
Phase 3d  →  Route /api/scanner/report + DB scanned_hosts
Phase 3e  →  Trigger manuel + WebSocket progress
Phase 4a  →  Nouveaux types nœuds frontend + badge "no agent"
Phase 4b  →  ScannerPanel (progress bar live)
Phase 4c  →  Filtres par type
Phase 5   →  install.sh + servir les binaires depuis le backend
```

---

## Conventions de code

- **Go** : `gofmt`, erreurs toujours traitées, pas de `panic` en prod
- **JS** : ESM, async/await, pas de callbacks
- **Nommage** : snake_case en DB et JSON, camelCase en JS, PascalCase composants React
- **Logs** : structured JSON (`log/slog` en Go, `pino` via Fastify en Node)
- **Secrets** : jamais dans le code, toujours depuis les env vars
- **Tests** : au minimum un test d'intégration par route auth, un test unitaire pour les heuristiques device type

---

## Points d'attention

1. **Scanner — `network_mode: host`** est obligatoire pour les raw ARP sockets. Ça signifie que le scanner doit tourner sur la machine qui a accès physique au réseau (ton Proxmox ou une VM dédiée avec accès au bridge).

2. **Proxmox TLS** : les certs auto-signés Proxmox vont faire échouer node-fetch. Mettre `NODE_TLS_REJECT_UNAUTHORIZED=0` en homelab, ou importer le CA Proxmox dans le conteneur serveur en prod.

3. **Agent Docker socket** : pour que l'agent puisse interroger Docker, il doit soit tourner en `root`, soit être dans le groupe `docker`. En conteneur, monter `/var/run/docker.sock:/var/run/docker.sock`.

4. **Refresh token httpOnly** : le refresh token ne doit jamais être accessible depuis JS (`httpOnly: true, secure: true, sameSite: 'strict'`). L'access token lui peut être en mémoire React (pas en localStorage pour éviter XSS).

5. **Rate limiting** : ajouter `@fastify/rate-limit` sur `/api/auth/login` (max 10 req/min par IP) pour éviter le brute-force.
