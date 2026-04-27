# Claude Session Manager (CSM) Design Spec

> **Date:** 2026-04-27
> **Status:** Draft — pending implementation plan

---

## 1. Goal

Build a lightweight, browser-based session manager for Claude Code running on remote Linux servers. It provides:

- **Session persistence**: Claude processes survive browser disconnects and SSH drops.
- **Multi-session management**: Create, switch, rename, and archive independent Claude sessions, each with its own working directory and memory.
- **Human-friendly Web UI**: A modern, terminal-embedded interface that is more pleasant than raw Tmux/SSH while keeping all native Claude Code interactions intact.

---

## 2. Architecture

CSM follows a **server-browser** model. The server runs on the Linux development host (where Claude Code is installed). The Mac client only needs a browser — no local installation beyond an SSH tunnel.

```
┌─────────────────────────────────────────────────────────────┐
│                      Mac Browser (Frontend)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Session List │  │ xterm.js     │  │ Session Info     │  │
│  │ (Web UI)     │  │ (Terminal)   │  │ (Memory/Status)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────┬───────────────────────────────────────┘
                      │ WebSocket
┌─────────────────────▼───────────────────────────────────────┐
│              Linux Server (Node.js Backend)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Session      │  │ PTY Manager  │  │ Memory Service   │  │
│  │ Controller   │  │ (node-pty)   │  │ (SQLite/JSON)    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│         │                 │                   │              │
│         └─────────────────┴───────────────────┘              │
│                           │                                  │
│              ┌────────────▼────────────┐                    │
│              │  Claude Code Process 1  │                    │
│              │  (独立工作目录+记忆)      │                    │
│              ├─────────────────────────┤                    │
│              │  Claude Code Process 2  │                    │
│              │  (独立工作目录+记忆)      │                    │
│              └─────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Data Flow

1. Browser opens the CSM web page (served by the Node.js HTTP server).
2. Browser establishes a WebSocket connection, optionally specifying a `sessionId`.
3. `SessionController` locates or creates the session; `PtyManager` spawns `claude` via `node-pty` if not already running.
4. PTY stdout is forwarded through the WebSocket as `output` messages; browser keystrokes are forwarded as `input` messages.
5. `MemoryService` records session metadata (name, cwd, timestamps) to SQLite independently of the PTY data stream.
6. On browser disconnect, the PTY process stays alive. On reconnect, the browser re-attaches to the existing PTY.

---

## 3. Backend Design

### 3.1 Tech Stack

- **Runtime:** Node.js 20+
- **HTTP Server:** Express
- **WebSocket:** `ws` library
- **PTY:** `node-pty`
- **Database:** `better-sqlite3` (synchronous, zero-config)
- **Language:** TypeScript, compiled with `tsc`

### 3.2 Module Breakdown

#### `SessionManager` (`server/session/manager.ts`)

- In-memory `Map<string, Session>` of active sessions.
- Methods:
  - `createSession(name, cwd, env?) → Session`
  - `getSession(id) → Session | undefined`
  - `listSessions() → Session[]`
  - `renameSession(id, name) → void`
  - `closeSession(id, force?) → void`
  - `attachClient(sessionId, ws) → void`
  - `detachClient(sessionId, ws) → void`
- Session state machine:
  - `running` — PTY alive, at least one WebSocket client attached.
  - `disconnected` — PTY alive, zero clients attached.
  - `stopped` — PTY exited.

#### `PtyService` (`server/session/pty.ts`)

- Wraps `node-pty.spawn`.
- Spawns `claude` with:
  - `cwd`: session working directory.
  - `env`: inherited + `CLAUDE_SESSION_ID`, `CLAUDE_CSM_MODE=1`.
- Forwards `onData` to all attached WebSockets.
- Writes WebSocket `input` messages into PTY stdin.
- Handles `exit` event → notifies `SessionManager` to mark `stopped`.
- Handles `resize` messages to update PTY dimensions.

#### `WebSocketRouter` (`server/ws/router.ts`)

- Upgrades HTTP connections at path `/ws?sessionId=<id>`.
- Message protocol (JSON, every frame):
  - **Client → Server**
    - `{ type: 'input', data: string }`
    - `{ type: 'resize', cols: number, rows: number }`
    - `{ type: 'ping' }`
  - **Server → Client**
    - `{ type: 'output', data: string }`
    - `{ type: 'status', status: 'running' | 'disconnected' | 'stopped' }`
    - `{ type: 'pong' }`
- On connect: if session exists and is `disconnected`, transition to `running`.
- On disconnect: transition to `disconnected` after a 30-second grace period (heartbeat timeout).

#### `MemoryService` (`server/memory/service.ts`)

- SQLite schema (`sessions` table):
  ```sql
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'disconnected', 'stopped')),
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  );
  ```
- Persists every state change and metadata update.
- On server startup: loads all non-`stopped` rows into `SessionManager` as `disconnected` (PTY not auto-restarted; user must click reconnect).
- REST API:
  - `GET /api/sessions`
  - `POST /api/sessions` body `{ name?, cwd }`
  - `PATCH /api/sessions/:id` body `{ name? }`
  - `DELETE /api/sessions/:id`
  - `GET /api/cwd-suggestions` — returns recently used `cwd` values.

#### `HttpServer` (`server/http/server.ts`)

- Express app:
  - `express.static('public/')` → `/`
  - REST API under `/api/*`
- Raw Node `http.Server` handles `upgrade` events for WebSocket.
- Graceful shutdown on `SIGINT`/`SIGTERM`:
  1. Stop accepting new connections.
  2. Send `SIGTERM` to all PTYs.
  3. Wait 5s, then `SIGKILL` any remaining PTYs.
  4. Close SQLite, exit.

### 3.3 Security

- Default bind: `127.0.0.1`.
- If `--host 0.0.0.0` is used, `--auth user:password` is strongly recommended (Basic HTTP auth).
- `cwd` is validated to be an absolute path and within the server's filesystem; no path traversal outside is permitted.
- WebSocket messages are terminal data only — no direct filesystem commands exposed.

---

## 4. Frontend Design

### 4.1 Tech Stack

- **Language:** TypeScript (no bundler in MVP; `tsc --outDir public/`)
- **Terminal:** `xterm.js` + `xterm-addon-fit`
- **Styling:** Plain CSS with CSS variables for dark/light themes (default dark)
- **Components:** Native Web Components or lightweight class-based components (no React/Vue to keep build simple)

### 4.2 Layout

Three-column layout (similar to VS Code):

```
+-----------------------------------------------------------+
| [Logo]  Claude Session Manager              [+ New] [⚙️] |
+-----------+------------------------------------+----------+
| Sessions  |                                    | Session  |
|           |                                    | Info     |
| [🟢] proj1|    ┌─────────────────────────┐    |          |
| [🟡] proj2|    │  $ claude               │    | Name:    |
| [⚫] proj3|    │  > How can I help?      │    | proj2    |
|           |    │                         │    |          |
| [+ SSH]   |    │  [Terminal Area]        │    | CWD:     |
|           |    │                         │    | /repo    |
+-----------+    │                         │    |          |
| Status:   |    └─────────────────────────┘    | Created: |
| 3 active  |                                    | 2h ago   |
+-----------+------------------------------------+----------+
```

- **Left — SessionList:**
  - Scrollable list of sessions.
  - Each item: status dot (🟢 running / 🟡 disconnected / ⚫ stopped), name, cwd abbreviation.
  - Click to switch focus.
  - Right-click context menu: Rename, Close, Reconnect (if stopped).
  - Bottom: "+ New Session" button.

- **Center — TerminalPanel:**
  - Full-height `xterm.js` instance.
  - On `resize` events from xterm, sends `resize` WS message.
  - Connection overlay:
    - Connecting: dim overlay + spinner.
    - Disconnected: "Disconnected — reconnecting in Ns..." with manual retry button.
    - Stopped: "Session ended. Press Enter to restart or create a new session."

- **Right — SessionInfo (collapsible):**
  - Editable session name.
  - CWD display with "Copy path" button.
  - Timestamps (created, last active).
  - Memory panel:
    - Scans `~/.claude/projects/<project-name>/memory/` server-side.
    - Lists memory files; click opens read-only preview (fetched via REST).

### 4.3 Key Behaviors

- **Auto-reconnect:** Exponential backoff (1s → 2s → 4s → 8s, cap 30s) on `onclose`.
- **Heartbeat:** Client sends `ping` every 15s; server replies `pong`. If two pings miss, mark disconnected.
- **Multi-tab sync:** Multiple browser tabs can attach to the same session; output is broadcast to all.
- **Keyboard shortcuts:**
  - `Cmd/Ctrl+Shift+N` — New session.
  - `Cmd/Ctrl+1..9` — Switch to nth session.
  - `Cmd/Ctrl+K` — Clear terminal (client-side only).
- **Browser notifications:** Optional permission-based notification when a watched session stops unexpectedly.

---

## 5. Deployment & Configuration

### 5.1 Distribution

Published as an npm package `claude-session-manager`.

```bash
# Global install
npm install -g claude-session-manager

# Start
csm --port 8080 --host 0.0.0.0

# Or via npx
npx claude-session-manager --port 8080
```

### 5.2 CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` / `-p` | `8080` | HTTP/WebSocket port |
| `--host` / `-h` | `127.0.0.1` | Bind address |
| `--data-dir` | `~/.csm` | SQLite, logs, config |
| `--claude-path` | auto (PATH) | Path to `claude` binary |
| `--auth` | none | Basic auth `user:password` |
| `--install-systemd` | false | Install systemd service |

### 5.3 SSH Tunnel (Recommended)

Mac local access should go through an SSH tunnel rather than exposing CSM to the public internet:

```bash
ssh -L 18080:localhost:8080 your-server
open http://localhost:18080
```

### 5.4 systemd Integration

`csm --install-systemd` generates `/etc/systemd/system/csm.service`:

```ini
[Unit]
Description=Claude Session Manager
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/csm --port 8080 --host 127.0.0.1
Restart=on-failure
User=%I

[Install]
WantedBy=multi-user.target
```

### 5.5 Configuration Files

- `~/.csm/config.json` — user overrides for CLI defaults.
- `~/.csm/sessions.db` — SQLite database.
- `~/.csm/logs/` — log rotation (`csm-YYYY-MM-DD.log`).

---

## 6. Error Handling

### 6.1 Network & Connection

- **Client disconnect:** Server waits 30s (heartbeat timeout), then marks `disconnected`. PTY stays alive.
- **Server restart:** On boot, reload session metadata from DB. Sessions are `disconnected` until a client reconnects and clicks "Reattach".
- **PTY crash:** `exit` code non-zero → broadcast `status: stopped`, log stderr tail to `~/.csm/logs/crashes/`.

### 6.2 Resource Limits

- **Max session age:** Default 7 days. Sessions older than this are gracefully terminated unless the user sets `"permanent": true` on the session.
- **Zombie cleanup:** A background interval (every 1h) scans for `disconnected` sessions > 24h and closes them.
- **Memory cap:** If total PTY output buffer exceeds 10MB per session, truncate oldest 20%.

### 6.3 Graceful Shutdown

On `SIGINT`/`SIGTERM`:
1. Close HTTP listener (no new WS connections).
2. Send `SIGTERM` to all PTYs.
3. Wait 5s, then `SIGKILL` survivors.
4. Flush SQLite WAL, close DB, exit(0).

---

## 7. Testing Strategy

### 7.1 Backend Unit Tests (`tests/server/`)

- **SessionManager:** state transitions, client attach/detach, CRUD.
- **MemoryService:** SQLite CRUD, migration, `cwd-suggestions` logic.
- **WebSocketRouter:** mock `ws` clients, verify protocol messages.
- **Framework:** vitest.

### 7.2 Integration Tests

- Spawn a real `node-pty` with `bash -c 'echo hello; sleep 60'`, connect via WebSocket, assert `output` contains `"hello"`.
- Disconnect client, assert process still in `ps`, reconnect, assert output continuity.

### 7.3 Manual Acceptance Checklist

- [ ] Create 3 sessions in different directories; confirm they are isolated.
- [ ] Disconnect browser network; confirm `claude` process remains in `ps aux`.
- [ ] Reconnect; confirm terminal output resumes without loss.
- [ ] Restart CSM server; confirm session list restores; reattach works.
- [ ] Open two browser tabs on the same session; confirm bidirectional sync.
- [ ] Close session from UI; confirm PTY terminates.
- [ ] Test `Cmd+K` clear, `Cmd+Shift+N` new session shortcuts.

---

## 8. Future Enhancements (Post-MVP)

- **AI summary of session history:** Parse Claude Code's output to auto-generate a one-line description for each session.
- **Search across sessions:** Full-text search of terminal scrollback.
- **Team sharing:** Read-only session sharing via unique link.
- **Custom themes / plugins:** Frontend plugin API.

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| **CSM** | Claude Session Manager (this project) |
| **PTY** | Pseudo-terminal; the interface `node-pty` creates to talk to `claude` |
| **Session** | One running (or stopped) Claude Code instance + its metadata |
| **Attach** | A WebSocket client connecting to an existing session's PTY |
| **Memory** | Claude Code's per-project memory files under `~/.claude/projects/.../memory/` |
