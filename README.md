# NetMap — Infra Topology Explorer

**Self-hosted network topology explorer.** Maps your infrastructure in real-time: Proxmox VMs, LXC containers, Docker workloads, bare-metal servers, and any device on your LAN — all in an interactive force-directed graph.

---

## Features

- **Interactive graph** — D3.js force-directed layout with zoom, drag, convex hull groups
- **ARP + nmap scanner** — discovers every device on your LAN, guesses type from MAC OUI and open ports
- **Proxmox VE integration** — polls VMs and LXC containers via the Proxmox API
- **Docker discovery** — lightweight Go agent reports containers, open ports, SMB/NFS shares
- **Real-time updates** — WebSocket push, no polling from the browser
- **JWT authentication** — access token (15 min) + httpOnly refresh cookie (7 days)
- **One-line agent install** — systemd service, auto-detects arch (amd64 / arm64 / arm)
- **Dark cyberpunk UI** — Orbitron + Azeret Mono, CRT scanlines, glow effects

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser  →  nginx :8080  →  /api, /ws  →  Fastify :3000   │
│                          ↘  /           →  React (static)  │
└─────────────────────────────────────────────────────────────┘

┌──────────────┐  Bearer token   ┌──────────────────────────┐
│  Go Agent    │ ─────────────►  │  POST /api/agent/report  │
│  (each VM)   │                 └──────────────────────────┘
└──────────────┘
                                 ┌──────────────────────────┐
┌──────────────┐  Bearer token   │  POST /api/scanner/report│
│  Go Scanner  │ ─────────────►  │  ARP sweep + nmap XML    │
│  (LAN host)  │                 └──────────────────────────┘
└──────────────┘
```

| Component | Technology |
|-----------|------------|
| Agent | Go 1.22, stdlib only — single static binary |
| Scanner | Go 1.22 + gopacket — ARP raw socket + nmap |
| Backend | Node 20, Fastify v4, better-sqlite3 (WAL) |
| Frontend | React 19, Vite, D3 v7 |
| Auth | JWT HS256, bcrypt, httpOnly refresh cookie |
| DB | SQLite 3 — zero infra, trivial backup |
| Proxy | nginx (bundled in the frontend image) |

---

## Quick Start

### Prerequisites

- Docker + Docker Compose v2
- `openssl`, `curl`
- Linux host for the ARP scanner (see [Scanner](#scanner))

### 1 — Clone & run the installer

```bash
git clone https://github.com/yourname/netmap.git
cd netmap
chmod +x setup.sh
./setup.sh
```

The installer will:
1. Ask for the HTTP port (default `8080`), admin password, optional Proxmox config and scan networks
2. Generate JWT secrets automatically
3. Build and start the Docker images
4. Create a scanner token and save it to `.env`
5. Optionally start the ARP scanner (Linux only)

Open **http://localhost:8080** and log in with `admin` / your chosen password.

### 2 — Manual setup

```bash
cp .env.example .env
# Edit .env — at minimum, generate the three required secrets:
sed -i "s/^JWT_SECRET=$/JWT_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^JWT_REFRESH_SECRET=$/JWT_REFRESH_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^AGENT_TOKEN_SALT=$/AGENT_TOKEN_SALT=$(openssl rand -hex 32)/" .env

docker compose build
docker compose up -d
```

---

## Configuration

All configuration lives in `.env` (copy from `.env.example`).

| Variable | Default | Description |
|----------|---------|-------------|
| `NETMAP_PORT` | `8080` | HTTP port for the web UI |
| `JWT_SECRET` | — | Signing key for access tokens **(required)** |
| `JWT_REFRESH_SECRET` | — | Signing key for refresh tokens **(required)** |
| `AGENT_TOKEN_SALT` | — | Extra entropy for agent token hashing **(required)** |
| `NETMAP_ADMIN_PASS` | *(generated)* | Initial admin password |
| `SCAN_NETWORKS` | `192.168.1.0/24` | Comma-separated CIDRs to scan |
| `SCAN_INTERVAL` | `300` | Seconds between full ARP scans |
| `SCANNER_TOKEN` | — | Bearer token for the scanner (created by `setup.sh`) |
| `PROXMOX_HOST` | — | `host:port` of your Proxmox server |
| `PROXMOX_USER` | `root@pam` | Proxmox API user |
| `PROXMOX_PASS` | — | Proxmox password |
| `PROXMOX_TLS` | `0` | `0` = ignore self-signed cert (homelab) |

---

## Agent

The agent is a small Go binary (~5 MB) that runs on each VM/VPS and reports:

- System info (OS, kernel, CPU, RAM, disk, uptime)
- Network interfaces
- Listening TCP ports (via `ss`)
- SMB shares (`/etc/samba/smb.conf`)
- NFS exports (`/etc/exports`)
- Docker containers (via Unix socket)

### Install on a VM

1. In the UI, click any **"NO AGENT"** node → **Copy install command**
2. Run the command on the target machine:

```bash
curl -fsSL http://<netmap-host>:8080/install.sh | \
  NETMAP_SERVER=http://<netmap-host>:8080 \
  NETMAP_TOKEN=<agent-token> \
  bash
```

The script auto-detects the architecture (amd64 / arm64 / armv7), downloads the binary, and installs a systemd service.

### Create an agent token manually

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<pass>"}' | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

curl -X POST http://localhost:8080/api/admin/tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-server","scope":"agent"}'
```

The raw token is returned **once** — copy it immediately.

---

## Scanner

The ARP scanner discovers every device on your LAN without requiring an agent.
It sends broadcast ARP requests, runs nmap on each responding host, and infers the device type from open ports and MAC OUI prefix.

> **Requires a Linux host.** Docker Desktop on macOS does not support `network_mode: host` for raw ARP sockets.

### Start on Linux

```bash
# Token is created automatically by setup.sh, or create one via the admin UI
docker compose --profile scanner up -d scanner
docker compose logs -f scanner
```

### Start from a remote Linux host

```bash
docker run --rm --net=host --cap-add=NET_RAW --cap-add=NET_ADMIN \
  -e NETMAP_SERVER=http://<netmap-ip>:8080 \
  -e NETMAP_TOKEN=<scanner-token> \
  -e SCAN_NETWORKS=192.168.1.0/24 \
  ghcr.io/yourname/netmap-scanner:latest
```

### Trigger a manual scan

Click **◉ SCAN NOW** in the header (admin only). A live progress bar shows the scan status in real time.

### Device type detection

| Priority | Signal | Examples |
|----------|--------|---------|
| 1 | Open port | 8006 → Proxmox · 5000/5001 → NAS · 1883 → IoT · 3389 → Windows |
| 2 | MAC OUI prefix | VMware/QEMU → VM · Synology → NAS · RPi Foundation → RPi |
| 3 | nmap OS string | "Windows" → Windows · "Cisco IOS" → Switch · "pfSense" → Firewall |
| 4 | Fallback | `scanned` |

---

## Development

```bash
# Hot-reload: server (node --watch) on :3000, frontend (Vite HMR) on :5173
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Build Go binaries locally:

```bash
# Agent
cd agent && go build -o netmap-agent .

# Agent cross-compile for arm64
GOOS=linux GOARCH=arm64 go build -o netmap-agent-arm64 .

# Scanner (requires libpcap-dev)
cd scanner && CGO_ENABLED=1 go build -o netmap-scanner .
```

---

## HTTPS / Reverse proxy

NetMap exposes plain HTTP on `NETMAP_PORT`. To add TLS, put Caddy or nginx in front.

**Caddy** (automatic TLS):

```
netmap.example.com {
    reverse_proxy localhost:8080
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name netmap.example.com;
    ssl_certificate     /etc/letsencrypt/live/netmap.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/netmap.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
    }
}
```

---

## API reference

All endpoints require `Authorization: Bearer <accessToken>` except `/api/auth/login` and `/api/health`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | — | Obtain access + refresh tokens |
| `POST` | `/api/auth/refresh` | cookie | Refresh access token |
| `POST` | `/api/auth/logout` | JWT | Revoke refresh token |
| `GET` | `/api/auth/me` | JWT | Current user info |
| `GET` | `/api/topology` | JWT | Full node + edge graph |
| `GET` | `/api/stats` | JWT | Counts (agents, VMs, containers, scanned) |
| `POST` | `/api/agent/report` | agent token | Agent data push |
| `POST` | `/api/scanner/report` | scanner token | Scanner results push |
| `GET` | `/api/scanner/trigger` | JWT (admin) | Trigger immediate scan |
| `GET` | `/api/admin/tokens` | JWT (admin) | List tokens |
| `POST` | `/api/admin/tokens` | JWT (admin) | Create token |
| `DELETE` | `/api/admin/tokens/:id` | JWT (admin) | Revoke token |
| `GET` | `/api/health` | — | Healthcheck |
| `GET` | `/ws` | JWT | WebSocket live updates |

---

## Project structure

```
netmap/
├── agent/                    Go binary — deployed on each VM/VPS
│   ├── main.go
│   └── deploy/
│       ├── install.sh        one-liner curl installer
│       └── systemd.service   template for manual install
├── scanner/                  Go ARP/nmap service
│   └── main.go
├── server/                   Fastify backend (Node 20)
│   └── src/
│       ├── index.js
│       ├── db.js             SQLite schema + prepared statements
│       ├── auth.js           JWT middleware
│       └── routes/           auth · agent · topology · scanner · admin
├── frontend/                 React 19 + Vite + D3
│   └── src/
│       ├── pages/            Login · Dashboard
│       ├── components/       TopologyGraph · DetailPanel · ScannerPanel
│       ├── hooks/            useAuth · useWebSocket · useTopology
│       └── lib/              api.js · nodeConfig.js
├── docker-compose.yml        Production stack
├── docker-compose.dev.yml    Dev override (hot-reload)
├── nginx-simple.conf         nginx with /api + /ws proxy
├── setup.sh                  Interactive installer
└── .env.example              Config template
```

---

## License

MIT
