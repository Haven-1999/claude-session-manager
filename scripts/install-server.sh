#!/usr/bin/env bash
set -euo pipefail

CSM_VERSION="${CSM_VERSION:-latest}"
DATA_DIR="${CSM_DATA_DIR:-$HOME/.csm}"
INSTALL_MODE="${CSM_INSTALL_MODE:-bare}"  # 'bare' or 'docker'

info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$1"; exit 1; }

check_node() {
  if command -v node &>/dev/null; then
    local node_version
    node_version=$(node --version | sed 's/v//')
    local major
    major=$(echo "$node_version" | cut -d. -f1)
    if [ "$major" -ge 20 ]; then
      info "Node.js v$node_version found."
      return 0
    else
      warn "Node.js v$node_version is too old (need >= 20)."
    fi
  fi
  return 1
}

install_node() {
  info "Installing Node.js 20 via 'n'..."
  if ! command -v npm &>/dev/null; then
    error "npm is required but not found. Please install Node.js 20+ manually."
  fi
  npm install -g n
  n 20
  # shellcheck source=/dev/null
  export PATH="$(dirname "$(n which 20)"):$PATH"
  hash -r
  info "Node.js $(node --version) installed."
}

install_bare_metal() {
  info "Installing CSM in bare-metal mode..."

  if ! check_node; then
    install_node
  fi

  if ! check_node; then
    error "Failed to install Node.js >= 20."
  fi

  info "Installing claude-session-manager..."
  npm install -g "claude-session-manager${CSM_VERSION:+@$CSM_VERSION}"

  if ! command -v csm &>/dev/null; then
    warn "'csm' not in PATH after global install."
    warn "You may need to add your npm global bin to PATH:"
    warn "  export PATH=\"\$(npm config get prefix)/bin:\$PATH\""
  fi

  mkdir -p "$DATA_DIR"

  local csm_bin
  csm_bin=$(command -v csm || true)
  if [ -z "$csm_bin" ]; then
    csm_bin="$(npm config get prefix)/bin/csm"
  fi

  local service_dir="$HOME/.config/systemd/user"
  mkdir -p "$service_dir"

  cat > "$service_dir/csm.service" <<EOF
[Unit]
Description=Claude Session Manager
After=network.target

[Service]
Type=simple
ExecStart=$csm_bin --host 0.0.0.0 --data-dir $DATA_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable csm
  systemctl --user restart csm

  info "CSM systemd user service installed and started."
  info "Status: systemctl --user status csm"
}

install_docker() {
  info "Docker mode selected."
  if ! command -v docker &>/dev/null; then
    error "Docker is not installed. Please install Docker first."
  fi

  info "To run CSM in Docker with persistent data, use:"
  cat <<'EOF'

  docker run -d \
    --name csm \
    -p 8080:8080 \
    -v csm-data:/root/.csm \
    -e NODE_ENV=production \
    your-csm-image

Replace 'your-csm-image' with the actual image name.

Important: the '-v csm-data:/root/.csm' flag is REQUIRED.
Without it, all session data will be lost when the container restarts.

EOF
}

print_next_steps() {
  local host_ip
  host_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<server-ip>")

  cat <<EOF

============================================================
                  CSM Server Ready
============================================================

Backend URL: http://$host_ip:8080

Mac Client Setup:
1. On your Mac, open Terminal and run:

   ssh -L 18080:localhost:8080 user@$host_ip

2. Open browser to: http://localhost:18080

Or use the Tauri Mac app (coming soon) to auto-manage the tunnel.

Data Directory: $DATA_DIR
Sessions DB:    $DATA_DIR/sessions.db

============================================================
EOF
}

main() {
  info "CSM Server Installer"
  info "Mode: $INSTALL_MODE"

  case "$INSTALL_MODE" in
    bare)
      install_bare_metal
      ;;
    docker)
      install_docker
      ;;
    *)
      error "Unknown install mode: $INSTALL_MODE. Use 'bare' or 'docker'."
      ;;
  esac

  print_next_steps
}

main "$@"
