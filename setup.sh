#!/usr/bin/env bash
# NetMap — Interactive CLI Installer
# Usage: ./setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

# ─── Helpers ─────────────────────────────────────────────────────────────────

banner() {
  clear
  echo -e "${CYAN}${BOLD}"
  cat << 'EOF'
  ███╗   ██╗███████╗████████╗███╗   ███╗ █████╗ ██████╗
  ████╗  ██║██╔════╝╚══██╔══╝████╗ ████║██╔══██╗██╔══██╗
  ██╔██╗ ██║█████╗     ██║   ██╔████╔██║███████║██████╔╝
  ██║╚██╗██║██╔══╝     ██║   ██║╚██╔╝██║██╔══██║██╔═══╝
  ██║ ╚████║███████╗   ██║   ██║ ╚═╝ ██║██║  ██║██║
  ╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝
EOF
  echo -e "${NC}${DIM}  Infra Topology Explorer — Installer v1.0${NC}"
  echo
}

step()  { echo -e "\n${CYAN}${BOLD}▶ $1${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${NC}  $1"; }
info()  { echo -e "  ${DIM}$1${NC}"; }
fatal() { echo -e "\n  ${RED}✗ $1${NC}\n"; exit 1; }

ask() {
  local -n _ref=$1
  local prompt="$2" default="${3:-}"
  if [ -n "$default" ]; then
    echo -ne "  ${BOLD}${prompt}${NC} ${DIM}[${default}]${NC}: "
  else
    echo -ne "  ${BOLD}${prompt}${NC}: "
  fi
  read -r _ref
  [ -z "$_ref" ] && _ref="$default"
}

askpw() {
  local -n _ref=$1
  local prompt="$2"
  echo -ne "  ${BOLD}${prompt}${NC}: "
  read -rs _ref; echo
}

askyn() {
  local -n _ref=$1
  local prompt="$2" default="${3:-y}"
  local hint="[Y/n]"; [ "$default" = "n" ] && hint="[y/N]"
  echo -ne "  ${BOLD}${prompt}${NC} ${DIM}${hint}${NC}: "
  read -r _ref
  [ -z "$_ref" ] && _ref="$default"
  [[ "$_ref" =~ ^[Yy] ]] && _ref="y" || _ref="n"
}

gen()  { openssl rand -hex 32; }
genp() { openssl rand -base64 16 | tr -d '/+=' | head -c 20; }

# sed -i portable (GNU/Linux vs BSD/macOS)
sedi() {
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# ─── Banner ───────────────────────────────────────────────────────────────────

banner

# ─── Step 1 : Prerequisites ──────────────────────────────────────────────────

step "Vérification des prérequis"

for cmd in docker curl openssl; do
  command -v "$cmd" &>/dev/null && ok "$cmd" || fatal "$cmd requis mais introuvable"
done

if docker compose version &>/dev/null 2>&1; then
  DC="docker compose"; ok "docker compose (v2)"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"; ok "docker-compose (v1)"
else
  fatal "docker compose introuvable"
fi

docker info &>/dev/null || fatal "Le daemon Docker n'est pas démarré"

OS_TYPE="$(uname -s)"
ok "OS : ${OS_TYPE}"

# ─── Step 2 : Configuration ──────────────────────────────────────────────────

step "Configuration"

REUSE_ENV="n"
if [ -f ".env" ]; then
  warn ".env existant détecté"
  askyn REUSE_ENV "Réutiliser le .env existant ?" "y"
fi

if [ "$REUSE_ENV" = "y" ]; then
  set -a; source .env; set +a
  ok ".env chargé"
else
  # ── Port ──
  ask NETMAP_PORT "Port HTTP de l'interface" "8080"

  # ── Admin password ──
  echo
  echo -ne "  ${BOLD}Mot de passe admin${NC} ${DIM}[générer automatiquement]${NC}: "
  read -rs NETMAP_ADMIN_PASS; echo
  if [ -z "$NETMAP_ADMIN_PASS" ]; then
    NETMAP_ADMIN_PASS="$(genp)"
    ok "Mot de passe généré : ${BOLD}${GREEN}${NETMAP_ADMIN_PASS}${NC}  ${RED}← notez-le !${NC}"
  fi

  # ── Proxmox ──
  echo
  askyn PROXMOX_ENABLE "Configurer l'intégration Proxmox ?" "n"
  PROXMOX_HOST=""; PROXMOX_USER="root@pam"; PROXMOX_PASS=""; PROXMOX_TLS="0"
  if [ "$PROXMOX_ENABLE" = "y" ]; then
    ask   PROXMOX_HOST "Proxmox host:port" "192.168.1.200:8006"
    ask   PROXMOX_USER "Proxmox user"      "root@pam"
    askpw PROXMOX_PASS "Proxmox password"
  fi

  # ── Scanner networks ──
  echo
  LOCAL_NET=""
  if command -v ip &>/dev/null; then
    LOCAL_NET=$(ip route 2>/dev/null \
      | awk '/proto kernel/ && !/^169/ {split($1,a,"."); print a[1]"."a[2]"."a[3]".0/24"; exit}')
  elif command -v ipconfig &>/dev/null; then
    LOCAL_NET="192.168.1.0/24"
  fi
  ask SCAN_NETWORKS "Réseaux à scanner (CIDRs, virgule)" "${LOCAL_NET:-192.168.1.0/24}"
  ask SCAN_INTERVAL "Intervalle de scan (secondes)"      "300"

  # ── Generate secrets ──
  JWT_SECRET=$(gen)
  JWT_REFRESH_SECRET=$(gen)
  AGENT_TOKEN_SALT=$(gen)
  SCANNER_TOKEN=""

  # ── Write .env ──
  cat > .env << ENVEOF
# Généré par NetMap setup.sh — $(date)

NETMAP_PORT=${NETMAP_PORT}

JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
AGENT_TOKEN_SALT=${AGENT_TOKEN_SALT}

NETMAP_ADMIN_PASS=${NETMAP_ADMIN_PASS}

PROXMOX_HOST=${PROXMOX_HOST}
PROXMOX_USER=${PROXMOX_USER}
PROXMOX_PASS=${PROXMOX_PASS}
PROXMOX_POLL=60
PROXMOX_TLS=${PROXMOX_TLS}

SCANNER_TOKEN=
SCAN_NETWORKS=${SCAN_NETWORKS}
SCAN_INTERVAL=${SCAN_INTERVAL}
NMAP_ARGS=-sV --top-ports 50 -O --osscan-limit -T4
ENVEOF

  ok ".env créé"
fi

# Charger le .env
set -a; source .env; set +a

# ─── Step 3 : Build ──────────────────────────────────────────────────────────

step "Build des images Docker"
info "Premier build : quelques minutes selon la connexion…"
echo

$DC build --parallel
ok "Images construites"

# ─── Step 4 : Start ──────────────────────────────────────────────────────────

step "Démarrage des services"

$DC up -d server frontend
ok "Conteneurs démarrés"

# Attendre que le serveur soit prêt
echo -ne "  Attente du serveur"
for i in $(seq 1 40); do
  if curl -sf "http://localhost:3000/api/health" &>/dev/null 2>&1; then
    echo -e " ${GREEN}✓${NC}"; break
  fi
  echo -n "."; sleep 2
  if [ "$i" -eq 40 ]; then
    echo -e " ${YELLOW}timeout${NC}"
    warn "Le serveur tarde à répondre. Vérifiez : $DC logs server"
  fi
done

# ─── Step 5 : Scanner token ──────────────────────────────────────────────────

step "Token scanner"

if [ -n "${SCANNER_TOKEN:-}" ]; then
  ok "Token scanner déjà configuré"
else
  LOGIN=$(curl -sf -X POST "http://localhost:3000/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${NETMAP_ADMIN_PASS}\"}" 2>/dev/null || echo '{}')

  ACCESS_TOKEN=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$ACCESS_TOKEN" ]; then
    warn "Authentification échouée — créez le token manuellement via l'interface admin"
  else
    TOKEN_RESP=$(curl -sf -X POST "http://localhost:3000/api/admin/tokens" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d '{"name":"scanner-local","scope":"scanner"}' 2>/dev/null || echo '{}')

    RAW_TOKEN=$(echo "$TOKEN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$RAW_TOKEN" ]; then
      sedi "s|^SCANNER_TOKEN=.*|SCANNER_TOKEN=${RAW_TOKEN}|" .env
      SCANNER_TOKEN="$RAW_TOKEN"
      export SCANNER_TOKEN
      ok "Token scanner créé et sauvegardé dans .env"
    else
      warn "Création du token échouée — utilisez l'interface admin"
    fi
  fi
fi

# ─── Step 6 : Scanner ────────────────────────────────────────────────────────

step "Scanner ARP/nmap"

if [ "$OS_TYPE" = "Linux" ]; then
  if [ -n "${SCANNER_TOKEN:-}" ]; then
    askyn START_SCANNER "Démarrer le scanner ARP maintenant ?" "y"
    if [ "$START_SCANNER" = "y" ]; then
      set -a; source .env; set +a
      $DC --profile scanner up -d scanner
      ok "Scanner démarré (intervalle: ${SCAN_INTERVAL:-300}s, réseaux: ${SCAN_NETWORKS:-?})"
    else
      info "Pour démarrer plus tard : $DC --profile scanner up -d scanner"
    fi
  else
    warn "Token manquant — scanner non démarré"
    info "Créez un token scope 'scanner' dans l'interface admin, puis relancez setup.sh"
  fi
else
  # macOS / autre
  HOST_IP=$(ipconfig getifaddr en0 2>/dev/null \
    || ip route get 1 2>/dev/null | awk '{print $7; exit}' \
    || echo "<IP-DE-CE-SERVEUR>")

  warn "macOS : network_mode host non supporté par Docker Desktop"
  echo
  echo -e "  ${BOLD}Lancer le scanner depuis un Linux sur ton réseau :${NC}"
  echo
  printf "  docker run --rm --net=host --cap-add=NET_RAW --cap-add=NET_ADMIN \\\n"
  printf "    -e NETMAP_SERVER=http://%s:%s \\\n" "$HOST_IP" "${NETMAP_PORT:-8080}"
  printf "    -e NETMAP_TOKEN=%s \\\n" "${SCANNER_TOKEN:-<token>}"
  printf "    -e SCAN_NETWORKS=%s \\\n" "${SCAN_NETWORKS:-192.168.1.0/24}"
  printf "    ghcr.io/netmap/scanner:latest\n"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}${BOLD}  ✓  NetMap est opérationnel${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo -e "  ${BOLD}Interface${NC}   ${GREEN}http://localhost:${NETMAP_PORT:-8080}${NC}"
echo -e "  ${BOLD}Login${NC}       admin / ${BOLD}${NETMAP_ADMIN_PASS}${NC}"
echo
echo -e "  ${DIM}Logs    :${NC} $DC logs -f"
echo -e "  ${DIM}Statut  :${NC} $DC ps"
echo -e "  ${DIM}Stop    :${NC} $DC down"
echo -e "  ${DIM}Rebuild :${NC} $DC build && $DC up -d"
echo
info "Pour installer un agent sur une VM :"
info "→ Cliquez sur un nœud 'NO AGENT' dans l'interface → Copy install command"
echo
