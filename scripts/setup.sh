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

verify_python_fallback() {
  info "Verifying Python PTY fallback..."
  if ! command -v python3 &>/dev/null; then
    return 1
  fi
  # Test that Python can create a PTY
  if python3 -c "import pty,os;m,s=pty.openpty();os.close(m);os.close(s);print('ok')" 2>/dev/null | grep -q ok; then
    success "Python PTY fallback: OK (python3 $(python3 --version 2>&1 | awk '{print $2}'))"
    return 0
  fi
  return 1
}

rebuild_node_pty() {
  warn "node-pty prebuilt binary not working, rebuilding from source..."
  npm rebuild node-pty 2>/dev/null
  if verify_node_pty; then
    return 0
  fi
  return 1
}

switch_to_node20() {
  if ! command -v nvm &>/dev/null && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh"
  fi

  if ! command -v nvm &>/dev/null; then
    warn "nvm not found, installing..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
  fi

  nvm install 20
  nvm use 20
  info "Switched to Node.js $(node --version)"

  # Pin Node version for future sessions
  echo "20" > "$PROJECT_DIR/.nvmrc"
  info "Created .nvmrc to pin Node.js 20 for this project"

  info "Reinstalling dependencies with Node.js 20..."
  rm -rf node_modules
  npm install --ignore-scripts
  npm rebuild better-sqlite3 2>/dev/null || true
  npm rebuild node-pty

  if verify_node_pty; then
    success "node-pty works with Node.js $(node --version)"
    return 0
  fi
  return 1
}

main() {
  PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$PROJECT_DIR"

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

  # Step 4: Install dependencies (skip postinstall exit on failure)
  info "Installing dependencies..."
  npm install --ignore-scripts
  npm rebuild better-sqlite3 2>/dev/null || true

  # Step 5: Verify PTY support (node-pty preferred, Python fallback acceptable)
  if ! verify_node_pty; then
    rebuild_node_pty || {
      warn "node-pty incompatible with current system."
      # Try switching to Node 20
      info "Attempting Node.js 20 (known compatible with node-pty)..."
      if ! switch_to_node20; then
        # node-pty completely broken - check Python fallback
        warn "node-pty unavailable on this system."
        if verify_python_fallback; then
          info "Server will use Python PTY fallback (fully functional)."
        else
          error "Neither node-pty nor Python PTY fallback available."
          error "Please install python3 or fix node-pty."
          exit 1
        fi
      fi
    }
  fi

  # Step 6: Verify Python3 is available (needed for PTY fallback)
  if ! command -v python3 &>/dev/null; then
    warn "python3 not found. If node-pty fails at runtime, PTY fallback won't work."
    warn "Consider installing python3 for maximum compatibility."
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
  info "  bash scripts/start.sh"
  echo
  info "Or with custom options:"
  info "  bash scripts/start.sh --port 8080 --host 0.0.0.0"
  echo
  if [[ -f ".nvmrc" ]]; then
    info "Note: This project uses Node.js $(cat .nvmrc). The start script"
    info "will automatically load the correct version via nvm."
  fi
}

main "$@"
