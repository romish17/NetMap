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

sedi() { sed -i "$@"; }

# Valeur par défaut — surchargée par check_docker_compose()
DC="docker compose"
NEED_SUDO_DOCKER=n   # mis à "y" si l'utilisateur vient d'être ajouté au groupe docker

# ─── Docker installation ─────────────────────────────────────────────────────

# Lit /etc/os-release et expose :
#   DISTRO_ID       (ex: ubuntu, debian, fedora, arch, alpine…)
#   DISTRO_NAME     (ex: "Ubuntu 22.04.3 LTS")
#   DISTRO_ID_LIKE  (ex: "debian" pour Linux Mint, "rhel fedora" pour CentOS)
detect_distro() {
  DISTRO_ID="unknown"; DISTRO_NAME="Linux"; DISTRO_ID_LIKE=""; DISTRO_VERSION=""
  if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
    DISTRO_VERSION="${VERSION_ID:-}"
    DISTRO_ID_LIKE="${ID_LIKE:-}"
  fi
}

# Lance l'installation Docker adaptée à la distribution détectée.
# Affiche la distro + la méthode choisie, demande confirmation.
install_docker_linux() {
  step "Installation de Docker"
  detect_distro

  echo -e "  Distribution : ${BOLD}${DISTRO_NAME}${NC}"
  echo

  # ── Choisir la méthode selon l'ID de la distro ──────────────────────────────
  local method=""

  case "$DISTRO_ID" in

    # ── Arch Linux et dérivés ──────────────────────────────────────────────────
    arch|manjaro|endeavouros|garuda|cachyos)
      method="pacman"
      ;;

    # ── Alpine Linux ───────────────────────────────────────────────────────────
    alpine)
      method="apk"
      ;;

    # ── Distros officiellement supportées par get.docker.com ──────────────────
    ubuntu|debian|raspbian|linuxmint|pop|kali|elementary|neon|\
    centos|rhel|fedora|almalinux|rocky|ol|amzn|\
    opensuse-leap|opensuse-tumbleweed|sles)
      method="get.docker.com"
      ;;

    # ── Distros dérivées non listées : vérifier ID_LIKE ───────────────────────
    *)
      for like in $DISTRO_ID_LIKE; do
        case "$like" in
          debian|ubuntu)              method="get.docker.com"; break ;;
          rhel|fedora|centos)         method="get.docker.com"; break ;;
          suse|opensuse)              method="get.docker.com"; break ;;
          arch)                       method="pacman";          break ;;
          alpine)                     method="apk";             break ;;
        esac
      done
      ;;
  esac

  # ── Affichage + confirmation avant d'agir ───────────────────────────────────
  if [ "$method" = "get.docker.com" ]; then
    echo -e "  Méthode      : ${BOLD}Script officiel Docker${NC} ${DIM}(get.docker.com)${NC}"
  elif [ "$method" = "pacman" ]; then
    echo -e "  Méthode      : ${BOLD}pacman${NC} ${DIM}(Arch Linux)${NC}"
  elif [ "$method" = "apk" ]; then
    echo -e "  Méthode      : ${BOLD}apk${NC} ${DIM}(Alpine Linux)${NC}"
  else
    echo
    warn "Distribution non reconnue (ID=${DISTRO_ID})"
    echo -e "  Consultez la documentation officielle :"
    echo -e "  ${CYAN}https://docs.docker.com/engine/install/${NC}"
    echo
    fatal "Installez Docker manuellement puis relancez setup.sh"
  fi

  echo
  askyn DO_INSTALL "Lancer l'installation maintenant ?" "y"
  [ "$DO_INSTALL" = "n" ] && fatal "Docker est requis pour continuer"

  # ── Exécution ────────────────────────────────────────────────────────────────
  case "$method" in

    get.docker.com)
      info "Téléchargement du script officiel…"
      curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
      sudo sh /tmp/get-docker.sh
      rm -f /tmp/get-docker.sh
      ;;

    pacman)
      sudo pacman -Sy --noconfirm docker
      ;;

    apk)
      sudo apk add --no-cache docker docker-cli-compose
      # Alpine utilise OpenRC plutôt que systemd
      if command -v rc-update &>/dev/null; then
        sudo rc-update add docker default
        sudo service docker start
        ok "Docker démarré via OpenRC"
        # Groupes + user
        if [ "${EUID:-$(id -u)}" -ne 0 ] && ! id -nG "$USER" | grep -qw docker; then
          sudo addgroup "$USER" docker 2>/dev/null || sudo usermod -aG docker "$USER" 2>/dev/null || true
          warn "Utilisateur '$USER' ajouté au groupe 'docker' (reconnectez-vous)"
          NEED_SUDO_DOCKER=y
        fi
        ok "Docker installé avec succès"
        return 0
      fi
      ;;
  esac

  # ── systemd : activer + démarrer ────────────────────────────────────────────
  if command -v systemctl &>/dev/null; then
    sudo systemctl enable --now docker
    ok "Service Docker activé et démarré"
  fi

  # ── Groupe docker pour l'utilisateur courant ────────────────────────────────
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    if ! id -nG "$USER" | grep -qw docker; then
      sudo usermod -aG docker "$USER"
      warn "Utilisateur '$USER' ajouté au groupe 'docker'"
      warn "Les prochaines sessions n'auront pas besoin de sudo"
      warn "Pour cette session, on continue avec 'sudo docker'…"
      NEED_SUDO_DOCKER=y
    fi
  fi

  ok "Docker installé avec succès"
}

check_and_install_docker() {
  local docker_found=n
  local daemon_running=n

  command -v docker &>/dev/null && docker_found=y
  [ "$docker_found" = "y" ] && docker info &>/dev/null 2>&1 && daemon_running=y

  # ── Cas 1 : Docker présent et daemon actif ───────────────────────────────────
  if [ "$docker_found" = "y" ] && [ "$daemon_running" = "y" ]; then
    DOCKER_VER=$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    ok "Docker ${DOCKER_VER} (daemon actif)"
    return 0
  fi

  # ── Cas 2 : Docker absent → installation ────────────────────────────────────
  if [ "$docker_found" = "n" ]; then
    install_docker_linux    # affiche distro + méthode + demande confirmation

  # ── Cas 3 : Docker installé mais daemon inactif ──────────────────────────────
  else
    warn "Docker est installé mais le daemon est arrêté"
    if command -v systemctl &>/dev/null; then
      info "Démarrage du service Docker…"
      sudo systemctl start docker
      sleep 2
      if docker info &>/dev/null 2>&1; then
        ok "Docker daemon démarré"
      else
        fatal "Impossible de démarrer Docker. Diagnostic : sudo systemctl status docker"
      fi
    elif command -v service &>/dev/null; then
      sudo service docker start
      sleep 2
      docker info &>/dev/null 2>&1 && ok "Docker daemon démarré" \
        || fatal "Impossible de démarrer Docker. Lancez-le manuellement."
    else
      fatal "Impossible de démarrer Docker automatiquement. Lancez-le manuellement."
    fi
  fi
}

check_docker_compose() {
  # Si l'utilisateur vient d'être ajouté au groupe docker dans cette session,
  # il faut sudo pour les commandes docker jusqu'à la prochaine connexion.
  local prefix=""
  [ "$NEED_SUDO_DOCKER" = "y" ] && prefix="sudo "

  if ${prefix}docker compose version &>/dev/null 2>&1; then
    DC="${prefix}docker compose"
    ok "${DC} v2"
    return 0
  fi

  if command -v docker-compose &>/dev/null && ${prefix}docker-compose version &>/dev/null 2>&1; then
    DC="${prefix}docker-compose"
    ok "${DC} v1"
    return 0
  fi

  # Compose manquant → installation automatique
  warn "Docker Compose plugin absent — installation…"
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y docker-compose-plugin 2>/dev/null \
      || sudo apt-get install -y docker-compose 2>/dev/null \
      || true
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y docker-compose-plugin 2>/dev/null || true
  elif command -v pacman &>/dev/null; then
    sudo pacman -Sy --noconfirm docker-compose 2>/dev/null || true
  fi

  if ${prefix}docker compose version &>/dev/null 2>&1; then
    DC="${prefix}docker compose"
    ok "${DC} installé"
    return 0
  fi

  # Fallback : binaire standalone depuis GitHub
  COMPOSE_VERSION="2.27.0"
  COMPOSE_ARCH="$(uname -m)"
  [ "$COMPOSE_ARCH" = "aarch64" ] && COMPOSE_ARCH="aarch64" || COMPOSE_ARCH="x86_64"
  COMPOSE_URL="https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}"
  info "Installation de docker compose ${COMPOSE_VERSION}…"
  sudo curl -fsSL "$COMPOSE_URL" -o /usr/local/bin/docker-compose
  sudo chmod +x /usr/local/bin/docker-compose
  DC="${prefix}docker-compose"
  ok "${DC} ${COMPOSE_VERSION} installé"
}

# ─── Banner ───────────────────────────────────────────────────────────────────

banner

# ─── Step 1 : OS + Docker ────────────────────────────────────────────────────

step "Vérification des prérequis"

OS_TYPE="$(uname -s)"
[ "$OS_TYPE" != "Linux" ] && fatal "setup.sh est prévu pour Linux uniquement (détecté : $OS_TYPE)"
ok "Linux ($(uname -m))"

# curl et openssl sont requis — installation automatique si absents
for cmd in curl openssl; do
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd"
  else
    warn "$cmd absent — installation…"
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y "$cmd"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y "$cmd"
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm "$cmd"
    else
      fatal "$cmd est requis mais ne peut pas être installé automatiquement"
    fi
    ok "$cmd installé"
  fi
done

# Docker (installation automatique si absent)
check_and_install_docker

# Docker Compose
check_docker_compose

# ─── Step 2 : Configuration ──────────────────────────────────────────────────

step "Configuration"

REUSE_ENV="n"
if [ -f ".env" ]; then
  if grep -q "^NETMAP_PORT" .env 2>/dev/null; then
    # .env compatible avec la version actuelle
    warn ".env existant détecté"
    askyn REUSE_ENV "Réutiliser le .env existant ?" "y"
  else
    # .env d'un ancien format (ex : avec DOMAIN/ACME_EMAIL pour Traefik)
    warn ".env détecté mais format obsolète — il sera sauvegardé et régénéré"
    cp .env ".env.bak.$(date +%Y%m%d_%H%M%S)"
    ok "Ancienne config sauvegardée (.env.bak.*)"
    REUSE_ENV="n"
  fi
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

# ─── Step 2b : Agent binaries ─────────────────────────────────────────────────

step "Binaires de l'agent Go"

if [ -d "downloads" ] && ls downloads/netmap-agent-linux-* &>/dev/null 2>&1; then
  ok "Binaires déjà présents dans downloads/"
elif command -v go &>/dev/null; then
  askyn BUILD_AGENT "Compiler les binaires agent (amd64 / arm64 / arm) ?" "y"
  if [ "$BUILD_AGENT" = "y" ]; then
    mkdir -p downloads
    info "Compilation agent linux/amd64…"
    (cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../downloads/netmap-agent-linux-amd64 .)
    info "Compilation agent linux/arm64…"
    (cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ../downloads/netmap-agent-linux-arm64 .)
    info "Compilation agent linux/arm…"
    (cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=arm   go build -ldflags="-s -w" -o ../downloads/netmap-agent-linux-arm   .)
    ok "Binaires compilés dans downloads/"
  else
    warn "Sans binaires, l'installation one-liner de l'agent ne fonctionnera pas"
    info "Compilez manuellement : cd agent && go build -o ../downloads/netmap-agent-linux-amd64 ."
  fi
else
  warn "Go non installé — binaires agent non compilés"
  info "Installez Go puis : cd agent && go build -ldflags=\"-s -w\" -o ../downloads/netmap-agent-linux-amd64 ."
  mkdir -p downloads
fi

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

# Attendre que le serveur soit healthy via docker inspect
# (le port 3000 n'est pas exposé sur l'hôte — seul nginx:8080 l'est)
echo -ne "  Attente du serveur (health check)"
SERVER_HEALTHY=n
for i in $(seq 1 40); do
  # Récupère le nom/id du conteneur server
  SRV=$($DC ps -q server 2>/dev/null | head -1)
  if [ -n "$SRV" ]; then
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$SRV" 2>/dev/null || echo "")
    if [ "$STATUS" = "healthy" ]; then
      echo -e " ${GREEN}✓${NC}"
      SERVER_HEALTHY=y
      break
    fi
  fi
  echo -n "."; sleep 2
  if [ "$i" -eq 40 ]; then
    echo -e " ${YELLOW}timeout${NC}"
    warn "Le serveur ne répond pas. Diagnostic : $DC logs server"
  fi
done

# Attendre que nginx (frontend) soit également up sur le port exposé
if [ "$SERVER_HEALTHY" = "y" ]; then
  echo -ne "  Attente de l'interface (nginx:${NETMAP_PORT:-8080})"
  for i in $(seq 1 20); do
    if curl -sf "http://localhost:${NETMAP_PORT:-8080}/api/health" &>/dev/null 2>&1; then
      echo -e " ${GREEN}✓${NC}"; break
    fi
    echo -n "."; sleep 2
    if [ "$i" -eq 20 ]; then
      echo -e " ${YELLOW}timeout${NC}"
      warn "nginx tarde à répondre. Diagnostic : $DC logs frontend"
    fi
  done
fi

# ─── Step 5 : Scanner token ──────────────────────────────────────────────────

step "Token scanner"

# Point d'entrée API : toujours via nginx (port exposé sur l'hôte)
API_BASE="http://localhost:${NETMAP_PORT:-8080}"

if [ -n "${SCANNER_TOKEN:-}" ]; then
  ok "Token scanner déjà configuré"
else
  LOGIN=$(curl -sf -X POST "${API_BASE}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${NETMAP_ADMIN_PASS}\"}" 2>/dev/null || echo '{}')

  ACCESS_TOKEN=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

  if [ -z "$ACCESS_TOKEN" ]; then
    warn "Authentification échouée — créez le token manuellement dans l'interface admin"
    info "→ http://localhost:${NETMAP_PORT:-8080} (onglet Admin › Tokens)"
  else
    TOKEN_RESP=$(curl -sf -X POST "${API_BASE}/api/admin/tokens" \
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
