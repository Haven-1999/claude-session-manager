#!/usr/bin/env bash
set -euo pipefail

info()  { printf '\033[1;36m[CSM]\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m[CSM]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[CSM]\033[0m %s\n' "$1"; }
success() { printf '\033[1;32m[CSM]\033[0m %s\n' "$1"; }

MIN_NODE_MAJOR=20
REQUIRED_NODE="20"

check_platform() {
  local os
  os="$(uname -s)"
  if [[ "$os" != "Darwin" && "$os" != "Linux" ]]; then
    error "Unsupported platform: $os"
    error "CSM supports macOS and Linux."
    exit 1
  fi
  info "Platform: $os $(uname -m)"
}

check_build_tools() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! xcode-select -p &>/dev/null; then
      warn "Xcode Command Line Tools not found."
      info "Installing Xcode Command Line Tools (required for native modules)..."
      xcode-select --install 2>/dev/null || true
      info "Please complete the Xcode tools installation popup, then re-run this script."
      exit 1
    fi
    info "Xcode Command Line Tools: OK"
  else
    if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
      warn "Build tools (gcc, make) not found."
      info "Installing build-essential..."
      if command -v apt-get &>/dev/null; then
        sudo apt-get update && sudo apt-get install -y build-essential python3
      elif command -v yum &>/dev/null; then
        sudo yum groupinstall -y "Development Tools"
      else
        error "Cannot auto-install build tools. Please install gcc and make manually."
        exit 1
      fi
    fi
    info "Build tools: OK"
  fi
}

check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local version
  version=$(node --version | sed 's/v//')
  local major
  major=$(echo "$version" | cut -d. -f1)
  if [[ "$major" -ge "$MIN_NODE_MAJOR" ]]; then
    info "Node.js: v$version"
    return 0
  fi
  warn "Node.js v$version is too old (need >= $MIN_NODE_MAJOR)."
  return 1
}

install_node_nvm() {
  if command -v nvm &>/dev/null || [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    info "nvm detected, installing Node.js $REQUIRED_NODE..."
    # shellcheck source=/dev/null
    [[ -s "$HOME/.nvm/nvm.sh" ]] && source "$HOME/.nvm/nvm.sh"
    nvm install "$REQUIRED_NODE"
    nvm use "$REQUIRED_NODE"
    return 0
  fi
  return 1
}

install_node() {
  if install_node_nvm; then
    return 0
  fi

  info "Installing nvm and Node.js $REQUIRED_NODE..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm install "$REQUIRED_NODE"
  nvm use "$REQUIRED_NODE"
}

verify_node_pty() {
  info "Verifying node-pty..."
  if node -e "const pty=require('node-pty');const p=pty.spawn('/bin/echo',['ok']);p.onData(()=>{});setTimeout(()=>{p.kill();process.exit(0)},500);" 2>/dev/null; then
    success "node-pty: OK"
    return 0
  fi
  return 1
}

rebuild_node_pty() {
  warn "node-pty prebuilt binary not working, rebuilding from source..."
  npm rebuild node-pty
  if verify_node_pty; then
    return 0
  fi
  error "node-pty rebuild failed."
  return 1
}

main() {
  info "=========================================="
  info "  Claude Session Manager - Setup"
  info "=========================================="
  echo

  # Step 1: Check platform
  check_platform

  # Step 2: Check build tools
  check_build_tools

  # Step 3: Check/install Node.js
  if ! check_node; then
    install_node
    if ! check_node; then
      error "Failed to install Node.js >= $MIN_NODE_MAJOR"
      exit 1
    fi
  fi

  # Step 4: Install dependencies
  info "Installing dependencies..."
  npm install

  # Step 5: Verify node-pty (rebuild if needed)
  if ! verify_node_pty; then
    rebuild_node_pty || {
      error "Cannot get node-pty working."
      error "Try manually: nvm install 20 && nvm use 20 && rm -rf node_modules && npm install"
      exit 1
    }
  fi

  # Step 6: Build
  info "Building project..."
  npm run build

  echo
  success "=========================================="
  success "  Setup complete!"
  success "=========================================="
  echo
  info "Start the server with:"
  info "  npm start"
  echo
  info "Or with custom options:"
  info "  npm start -- --port 8080 --host 0.0.0.0"
  echo
}

main "$@"
