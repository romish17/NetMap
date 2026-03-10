#!/usr/bin/env bash
# NetMap — Interactive CLI Installer
# Usage: ./setup.sh
# Relancer pour une réinstallation : ./setup.sh
#   → détecte le .env existant et propose de le réutiliser ou de reconfigurer

# -u  : erreur sur variable non définie
# -o pipefail : erreur si un élément d'un pipe échoue
# PAS de -e : on gère les erreurs manuellement pour éviter les exits silencieux
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Couleurs ────────────────────────────────────────────────────────────────

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

# Lecture d'une valeur avec valeur par défaut optionnelle
ask() {
  local -n _ref=$1
  local prompt="$2" default="${3:-}"
  if [ -n "$default" ]; then
    echo -ne "  ${BOLD}${prompt}${NC} ${DIM}[${default}]${NC}: "
  else
    echo -ne "  ${BOLD}${prompt}${NC}: "
  fi
  read -r _ref || true
  [ -z "${_ref:-}" ] && _ref="$default"
}

# Lecture d'un mot de passe (masqué)
askpw() {
  local -n _ref=$1
  local prompt="$2"
  echo -ne "  ${BOLD}${prompt}${NC}: "
  read -rs _ref || true
  echo
}

# Lecture oui/non
askyn() {
  local -n _ref=$1
  local prompt="$2" default="${3:-y}"
  local hint="[Y/n]"
  [ "$default" = "n" ] && hint="[y/N]"
  echo -ne "  ${BOLD}${prompt}${NC} ${DIM}${hint}${NC}: "
  read -r _ref || true
  [ -z "${_ref:-}" ] && _ref="$default"
  if [[ "${_ref:-n}" =~ ^[Yy] ]]; then _ref="y"; else _ref="n"; fi
}

gen()  { openssl rand -hex 32; }
genp() { openssl rand -base64 16 | tr -d '/+=' | head -c 20; }
sedi() { sed -i "$@"; }

# Valeurs par défaut globales
DC="docker compose"
NEED_SUDO_DOCKER=n

# ─── Détection distro ─────────────────────────────────────────────────────────

detect_distro() {
  DISTRO_ID="unknown"
  DISTRO_NAME="Linux"
  DISTRO_ID_LIKE=""

  if [ ! -f /etc/os-release ]; then return; fi

  # Lire uniquement les champs nécessaires sans polluer l'environnement global
  local line key val
  while IFS='=' read -r key val; do
    val="${val//\"/}"   # enlever les guillemets
    case "$key" in
      ID)          DISTRO_ID="$val" ;;
      ID_LIKE)     DISTRO_ID_LIKE="$val" ;;
      PRETTY_NAME) DISTRO_NAME="$val" ;;
      NAME)        [ -z "${DISTRO_NAME:-}" ] && DISTRO_NAME="$val" ;;
    esac
  done < /etc/os-release
}

# ─── Installation Docker ──────────────────────────────────────────────────────

install_docker_linux() {
  step "Installation de Docker"
  detect_distro
  echo -e "  Distribution : ${BOLD}${DISTRO_NAME}${NC}"
  echo

  # Choisir la méthode selon l'ID de la distro
  local method=""
  case "$DISTRO_ID" in
    arch|manjaro|endeavouros|garuda|cachyos)
      method="pacman" ;;
    alpine)
      method="apk" ;;
    ubuntu|debian|raspbian|linuxmint|pop|kali|elementary|neon|\
    centos|rhel|fedora|almalinux|rocky|ol|amzn|\
    opensuse-leap|opensuse-tumbleweed|sles)
      method="get.docker.com" ;;
    *)
      # Essayer via ID_LIKE pour les distros dérivées
      local like
      for like in ${DISTRO_ID_LIKE:-}; do
        case "$like" in
          debian|ubuntu)        method="get.docker.com"; break ;;
          rhel|fedora|centos)   method="get.docker.com"; break ;;
          suse|opensuse)        method="get.docker.com"; break ;;
          arch)                 method="pacman";          break ;;
          alpine)               method="apk";             break ;;
        esac
      done
      ;;
  esac

  if [ -z "$method" ]; then
    warn "Distribution non reconnue (ID=${DISTRO_ID})"
    echo -e "  Documentation : ${CYAN}https://docs.docker.com/engine/install/${NC}"
    fatal "Installez Docker manuellement puis relancez setup.sh"
  fi

  case "$method" in
    get.docker.com) echo -e "  Méthode : ${BOLD}Script officiel Docker${NC} ${DIM}(get.docker.com)${NC}" ;;
    pacman)         echo -e "  Méthode : ${BOLD}pacman${NC}" ;;
    apk)            echo -e "  Méthode : ${BOLD}apk${NC}" ;;
  esac
  echo

  local do_install
  askyn do_install "Lancer l'installation ?" "y"
  [ "$do_install" = "n" ] && fatal "Docker est requis pour continuer"

  case "$method" in
    get.docker.com)
      info "Téléchargement du script officiel Docker…"
      curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
        || fatal "Impossible de télécharger get.docker.com"
      sudo sh /tmp/get-docker.sh || fatal "Échec de l'installation Docker"
      rm -f /tmp/get-docker.sh
      ;;
    pacman)
      sudo pacman -Sy --noconfirm docker || fatal "Échec de l'installation Docker"
      ;;
    apk)
      sudo apk add --no-cache docker docker-cli-compose \
        || fatal "Échec de l'installation Docker"
      if command -v rc-update &>/dev/null; then
        sudo rc-update add docker default
        sudo service docker start
        ok "Docker démarré via OpenRC"
        if [ "${EUID:-$(id -u)}" -ne 0 ] && ! id -nG "$USER" 2>/dev/null | grep -qw docker; then
          sudo addgroup "$USER" docker 2>/dev/null \
            || sudo usermod -aG docker "$USER" 2>/dev/null || true
          warn "Utilisateur '$USER' ajouté au groupe 'docker'"
          NEED_SUDO_DOCKER=y
        fi
        ok "Docker installé avec succès"
        return 0
      fi
      ;;
  esac

  # systemd : activer et démarrer
  if command -v systemctl &>/dev/null; then
    sudo systemctl enable --now docker || warn "systemctl enable docker échoué"
    ok "Service Docker activé et démarré"
  fi

  # Ajouter l'utilisateur courant au groupe docker
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    if ! id -nG "$USER" 2>/dev/null | grep -qw docker; then
      sudo usermod -aG docker "$USER" && \
        warn "Utilisateur '$USER' ajouté au groupe 'docker' — sudo utilisé pour cette session"
      NEED_SUDO_DOCKER=y
    fi
  fi

  ok "Docker installé avec succès"
}

check_and_install_docker() {
  if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    local ver
    ver=$(docker --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    ok "Docker ${ver}"
    return 0
  fi

  if ! command -v docker &>/dev/null; then
    install_docker_linux
  else
    warn "Docker installé mais le daemon est arrêté"
    if command -v systemctl &>/dev/null; then
      info "Démarrage du service Docker…"
      sudo systemctl start docker
      sleep 2
      docker info &>/dev/null 2>&1 \
        && ok "Docker daemon démarré" \
        || fatal "Impossible de démarrer Docker. Diagnostic : sudo systemctl status docker"
    elif command -v service &>/dev/null; then
      sudo service docker start
      sleep 2
      docker info &>/dev/null 2>&1 \
        && ok "Docker daemon démarré" \
        || fatal "Impossible de démarrer Docker. Lancez-le manuellement."
    else
      fatal "Impossible de démarrer Docker automatiquement."
    fi
  fi
}

check_docker_compose() {
  local prefix=""
  [ "$NEED_SUDO_DOCKER" = "y" ] && prefix="sudo "

  if ${prefix}docker compose version &>/dev/null 2>&1; then
    DC="${prefix}docker compose"
    local ver
    ver=$(${prefix}docker compose version --short 2>/dev/null || echo "v2")
    ok "${DC} (${ver})"
    return 0
  fi

  if command -v docker-compose &>/dev/null && ${prefix}docker-compose version &>/dev/null 2>&1; then
    DC="${prefix}docker-compose"
    ok "${DC}"
    return 0
  fi

  warn "Docker Compose absent — installation…"
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y docker-compose-plugin 2>/dev/null \
      || sudo apt-get install -y docker-compose 2>/dev/null || true
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

  # Fallback : binaire standalone GitHub
  local arch ver_comp url
  arch="$(uname -m)"
  [ "$arch" = "aarch64" ] && arch="aarch64" || arch="x86_64"
  ver_comp="2.27.0"
  url="https://github.com/docker/compose/releases/download/v${ver_comp}/docker-compose-linux-${arch}"
  info "Téléchargement docker compose ${ver_comp}…"
  sudo curl -fsSL "$url" -o /usr/local/bin/docker-compose \
    || fatal "Impossible de télécharger docker-compose"
  sudo chmod +x /usr/local/bin/docker-compose
  DC="${prefix}docker-compose"
  ok "${DC} ${ver_comp} installé"
}

# ─────────────────────────────────────────────────────────────────────────────
banner

# ─── Étape 1 : Prérequis ─────────────────────────────────────────────────────

step "Vérification des prérequis"

[ "$(uname -s)" != "Linux" ] && fatal "setup.sh est prévu pour Linux uniquement"
ok "Linux ($(uname -m))"

for cmd in curl openssl; do
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd"
  else
    warn "$cmd absent — installation…"
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y "$cmd" || fatal "Impossible d'installer $cmd"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y "$cmd" || fatal "Impossible d'installer $cmd"
    elif command -v pacman &>/dev/null; then
      sudo pacman -Sy --noconfirm "$cmd" || fatal "Impossible d'installer $cmd"
    else
      fatal "$cmd est requis. Installez-le manuellement."
    fi
    ok "$cmd installé"
  fi
done

check_and_install_docker
check_docker_compose

# ─── Étape 2 : Configuration ──────────────────────────────────────────────────

step "Configuration"

REUSE_ENV="n"
REINSTALL=n

if [ -f ".env" ] && grep -q "^NETMAP_PORT" .env 2>/dev/null; then
  warn ".env existant détecté (format compatible)"
  askyn REUSE_ENV "Réutiliser la configuration existante ? (non = reconfigurer)" "y"
  if [ "$REUSE_ENV" = "y" ]; then
    set -a; source .env; set +a
    ok ".env chargé"
    REINSTALL=y
  fi
elif [ -f ".env" ]; then
  warn ".env détecté mais format obsolète — il sera sauvegardé et régénéré"
  cp .env ".env.bak.$(date +%Y%m%d_%H%M%S)"
  ok "Ancienne config sauvegardée (.env.bak.*)"
fi

if [ "$REUSE_ENV" = "n" ]; then

  # ── Port ──────────────────────────────────────────────────────────────────
  ask NETMAP_PORT "Port HTTP de l'interface" "8080"
  echo

  # ── Mot de passe admin ────────────────────────────────────────────────────
  echo -ne "  ${BOLD}Mot de passe admin${NC} ${DIM}[laisser vide = générer]${NC}: "
  read -rs NETMAP_ADMIN_PASS || true
  echo
  if [ -z "${NETMAP_ADMIN_PASS:-}" ]; then
    NETMAP_ADMIN_PASS="$(genp)"
    ok "Mot de passe généré : ${BOLD}${GREEN}${NETMAP_ADMIN_PASS}${NC}  ${RED}← notez-le !${NC}"
  fi
  echo

  # ── Proxmox ───────────────────────────────────────────────────────────────
  local_proxmox_enable=""
  askyn local_proxmox_enable "Configurer l'intégration Proxmox ?" "n"
  PROXMOX_HOST=""
  PROXMOX_USER="root@pam"
  PROXMOX_PASS=""
  PROXMOX_TLS="0"
  if [ "$local_proxmox_enable" = "y" ]; then
    ask   PROXMOX_HOST "Proxmox host:port" "192.168.1.200:8006"
    ask   PROXMOX_USER "Proxmox user"      "root@pam"
    askpw PROXMOX_PASS "Proxmox password"
    local tls_ans=""
    askyn tls_ans "Ignorer le certificat auto-signé ? (recommandé homelab)" "y"
    [ "$tls_ans" = "y" ] && PROXMOX_TLS="0" || PROXMOX_TLS="1"
  fi
  echo

  # ── Réseaux à scanner ─────────────────────────────────────────────────────
  LOCAL_NET=""
  if command -v ip &>/dev/null; then
    LOCAL_NET=$(ip route 2>/dev/null \
      | awk '/proto kernel/ && !/^169\./ {
          split($1,a,"."); printf "%s.%s.%s.0/24",a[1],a[2],a[3]; exit
        }' || true)
  fi
  ask SCAN_NETWORKS "Réseaux à scanner (CIDRs, virgule)" "${LOCAL_NET:-192.168.1.0/24}"
  ask SCAN_INTERVAL "Intervalle de scan (secondes)"      "300"

  # ── Génération des secrets ────────────────────────────────────────────────
  JWT_SECRET=$(gen)
  JWT_REFRESH_SECRET=$(gen)
  AGENT_TOKEN_SALT=$(gen)
  SCANNER_TOKEN=""

  # ── Écriture du .env ──────────────────────────────────────────────────────
  cat > .env <<ENVEOF
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

  [ -f ".env" ] && ok ".env créé" || fatal "Impossible d'écrire le fichier .env !"
fi

# Chargement garanti du .env dans l'environnement
set -a; source .env; set +a

# ─── Étape 2b : Binaires agent Go ─────────────────────────────────────────────

step "Binaires de l'agent Go"

mkdir -p downloads

if ls downloads/netmap-agent-linux-* &>/dev/null 2>&1; then
  ok "Binaires déjà présents dans downloads/"
elif command -v go &>/dev/null; then
  local_build_agent=""
  askyn local_build_agent "Compiler les binaires agent (amd64 / arm64 / arm) ?" "y"
  if [ "$local_build_agent" = "y" ]; then
    local goarch
    for goarch in amd64 arm64 arm; do
      info "Compilation linux/${goarch}…"
      if (cd agent && CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
          go build -ldflags="-s -w" -o "../downloads/netmap-agent-linux-${goarch}" . 2>&1); then
        ok "linux/${goarch}"
      else
        warn "linux/${goarch} — échec (ignoré)"
      fi
    done
  else
    info "Binaires non compilés. Pour les créer manuellement :"
    info "  cd agent && go build -o ../downloads/netmap-agent-linux-amd64 ."
  fi
else
  warn "Go non installé — binaires agent non compilés"
  info "Pour les créer : cd agent && go build -ldflags=\"-s -w\" -o ../downloads/netmap-agent-linux-amd64 ."
fi

# ─── Étape 3 : Build Docker ───────────────────────────────────────────────────

step "Build des images Docker"

# Réinstallation : arrêter les conteneurs en cours
if [ "$REINSTALL" = "y" ]; then
  info "Arrêt des conteneurs existants…"
  $DC down --remove-orphans 2>/dev/null || true
  ok "Conteneurs arrêtés"
fi

info "Build en cours (peut prendre plusieurs minutes)…"
echo
$DC build --parallel || fatal "Build Docker échoué — vérifiez les logs ci-dessus."
ok "Images construites"

# ─── Étape 4 : Démarrage ─────────────────────────────────────────────────────

step "Démarrage des services"

$DC up -d server frontend \
  || fatal "Impossible de démarrer les conteneurs. Vérifiez : $DC logs"
ok "Conteneurs lancés"

# Attendre que le serveur soit healthy via docker inspect
# (le port 3000 n'est pas exposé — on utilise l'état interne du conteneur)
echo -ne "  Attente du serveur"
SERVER_HEALTHY=n
for i in $(seq 1 50); do
  SRV_ID=$($DC ps -q server 2>/dev/null | head -1 || true)
  if [ -n "${SRV_ID:-}" ]; then
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$SRV_ID" 2>/dev/null || echo "")
    if [ "${STATUS:-}" = "healthy" ]; then
      echo -e " ${GREEN}✓${NC}"
      SERVER_HEALTHY=y
      break
    fi
  fi
  echo -n "."; sleep 2
  if [ "$i" -eq 50 ]; then
    echo -e " ${YELLOW}timeout${NC}"
    warn "Serveur non prêt après 100s"
    warn "Diagnostic : $DC logs server"
  fi
done

# Attendre que nginx soit joignable sur le port exposé
if [ "$SERVER_HEALTHY" = "y" ]; then
  echo -ne "  Attente de l'interface (port ${NETMAP_PORT})"
  for i in $(seq 1 25); do
    if curl -sf "http://localhost:${NETMAP_PORT}/api/health" &>/dev/null 2>&1; then
      echo -e " ${GREEN}✓${NC}"
      break
    fi
    echo -n "."; sleep 2
    if [ "$i" -eq 25 ]; then
      echo -e " ${YELLOW}timeout${NC}"
      warn "nginx non prêt. Diagnostic : $DC logs frontend"
    fi
  done
fi

# ─── Étape 5 : Token scanner ──────────────────────────────────────────────────

step "Token scanner"

API_BASE="http://localhost:${NETMAP_PORT}"

if [ -n "${SCANNER_TOKEN:-}" ]; then
  ok "Token scanner déjà configuré"
elif [ "$SERVER_HEALTHY" = "y" ]; then
  LOGIN=$(curl -sf -X POST "${API_BASE}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"admin\",\"password\":\"${NETMAP_ADMIN_PASS}\"}" \
    2>/dev/null || echo '{}')

  ACCESS_TOKEN=$(echo "$LOGIN" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4 || true)

  if [ -z "${ACCESS_TOKEN:-}" ]; then
    warn "Authentification échouée — créez le token manuellement"
    info "→ ${API_BASE} › Admin › Tokens"
  else
    TOKEN_RESP=$(curl -sf -X POST "${API_BASE}/api/admin/tokens" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d '{"name":"scanner-local","scope":"scanner"}' \
      2>/dev/null || echo '{}')

    RAW_TOKEN=$(echo "$TOKEN_RESP" | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)

    if [ -n "${RAW_TOKEN:-}" ]; then
      sedi "s|^SCANNER_TOKEN=.*|SCANNER_TOKEN=${RAW_TOKEN}|" .env
      SCANNER_TOKEN="$RAW_TOKEN"
      ok "Token scanner créé et sauvegardé dans .env"
    else
      warn "Création du token échouée — utilisez l'interface admin"
    fi
  fi
else
  warn "Serveur non disponible — token scanner non créé"
  info "Relancez setup.sh une fois le serveur opérationnel"
fi

# ─── Étape 6 : Scanner ARP ────────────────────────────────────────────────────

step "Scanner ARP/nmap"

if [ -n "${SCANNER_TOKEN:-}" ]; then
  local_scanner=""
  askyn local_scanner "Démarrer le scanner ARP maintenant ?" "y"
  if [ "$local_scanner" = "y" ]; then
    set -a; source .env; set +a
    if $DC --profile scanner up -d scanner; then
      ok "Scanner démarré (réseaux: ${SCAN_NETWORKS}, intervalle: ${SCAN_INTERVAL}s)"
    else
      warn "Impossible de démarrer le scanner. Vérifiez : $DC logs scanner"
    fi
  else
    info "Pour démarrer le scanner plus tard :"
    info "  $DC --profile scanner up -d scanner"
  fi
else
  warn "Token manquant — scanner non démarré"
  info "Créez un token scope 'scanner' dans l'interface admin, puis relancez setup.sh"
fi

# ─── Résumé ───────────────────────────────────────────────────────────────────

LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}' || echo "?")

echo
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}${BOLD}  ✓  NetMap est opérationnel${NC}"
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo -e "  ${BOLD}Interface locale ${NC}  ${GREEN}http://localhost:${NETMAP_PORT}${NC}"
echo -e "  ${BOLD}Interface réseau${NC}   ${GREEN}http://${LOCAL_IP}:${NETMAP_PORT}${NC}"
echo -e "  ${BOLD}Login${NC}              admin / ${BOLD}${NETMAP_ADMIN_PASS}${NC}"
echo
echo -e "  ${DIM}Logs    :${NC} $DC logs -f"
echo -e "  ${DIM}Statut  :${NC} $DC ps"
echo -e "  ${DIM}Stop    :${NC} $DC down"
echo -e "  ${DIM}Rebuild :${NC} $DC build && $DC up -d"
echo
info "Pour installer un agent sur une VM :"
info "→ Cliquez sur un nœud 'NO AGENT' dans l'interface → Copy install command"
echo
