#!/usr/bin/env bash
# NetMap Agent - One-liner installer
# Usage: curl -fsSL https://netmap.your-domain/install.sh | \
#   NETMAP_SERVER=https://netmap.your-domain \
#   NETMAP_TOKEN=<token> \
#   bash

set -euo pipefail

NETMAP_SERVER="${NETMAP_SERVER:?NETMAP_SERVER is required}"
NETMAP_TOKEN="${NETMAP_TOKEN:?NETMAP_TOKEN is required}"
INSTALL_DIR="/usr/local/bin"
SERVICE_NAME="netmap-agent"

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
  x86_64)  ARCH=amd64  ;;
  aarch64) ARCH=arm64  ;;
  armv7l)  ARCH=arm    ;;
  *) echo "[netmap] Unsupported architecture: $ARCH" && exit 1 ;;
esac

echo "[netmap] Downloading agent (linux/$ARCH)..."
curl -fsSL "$NETMAP_SERVER/downloads/netmap-agent-linux-$ARCH" \
  -o "$INSTALL_DIR/netmap-agent"
chmod +x "$INSTALL_DIR/netmap-agent"

echo "[netmap] Installing systemd service..."
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
echo "[netmap] Agent installed and started ✓"
systemctl status "$SERVICE_NAME" --no-pager
