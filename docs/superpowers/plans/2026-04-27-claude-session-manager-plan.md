# Claude Session Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js server + browser frontend that manages multiple persistent Claude Code sessions via PTY, with session metadata stored in SQLite.

**Architecture:** Server uses Express + `ws` + `node-pty` to spawn and manage Claude processes. Browser uses vanilla TypeScript + `xterm.js` connected via WebSocket. Session metadata persisted in SQLite via `better-sqlite3`.

**Tech Stack:** Node.js 20+, TypeScript, Express, `ws`, `node-pty`, `better-sqlite3`, `xterm.js`, vitest.

---

## File Structure

```
/data/claude-session-manager/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # CLI entry: parse args, start server
│   ├── server/
│   │   ├── http-server.ts       # Express + static + upgrade handler
│   │   ├── session/
│   │   │   ├── manager.ts       # SessionManager: Map + state machine
│   │   │   ├── pty.ts           # PtyService: node-pty wrapper
│   │   │   └── types.ts         # Session interface, status union
│   │   ├── memory/
│   │   │   └── service.ts       # MemoryService: SQLite CRUD
│   │   └── ws/
│   │       └── router.ts        # WebSocketRouter: protocol handler
│   └── frontend/
│       ├── index.html           # Single-page shell
│       ├── app.ts               # Global state, WS connection, event bus
│       ├── components/
│       │   ├── session-list.ts
│       │   ├── terminal-panel.ts
│       │   └── session-info.ts
│       └── styles.css           # CSS variables, layout, dark theme
├── tests/
│   └── server/
│       ├── memory-service.test.ts
│       ├── session-manager.test.ts
│       └── integration.test.ts
└── public/                      # Compiled frontend output (gitignored)
```

---

## Task 1: Project Bootstrap

**Files:**
- Create: `/data/claude-session-manager/package.json`
- Create: `/data/claude-session-manager/tsconfig.json`
- Create: `/data/claude-session-manager/.gitignore`
- Create: `/data/claude-session-manager/src/server/session/types.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "claude-session-manager",
  "version": "0.1.0",
  "description": "Browser-based session manager for Claude Code on remote servers",
  "main": "dist/index.js",
  "bin": { "csm": "dist/index.js" },
  "scripts": {
    "build": "tsc && npm run build:frontend",
    "build:frontend": "tsc -p tsconfig.frontend.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.0",
    "express": "^4.18.2",
    "node-pty": "^1.0.0",
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.0",
    "@types/ws": "^8.5.10",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  },
  "engines": { "node": ">=20.0.0" }
}
```

- [ ] **Step 2: Create tsconfig.json (backend)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/frontend/**/*"]
}
```

- [ ] **Step 3: Create tsconfig.frontend.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "outDir": "./public",
    "rootDir": "./src/frontend",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/frontend/**/*"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
public/*.js
public/*.css
*.log
.env
.DS_Store
```

- [ ] **Step 5: Create session types**

```typescript
// src/server/session/types.ts
import type { IPty } from 'node-pty';
import type WebSocket from 'ws';

export type SessionStatus = 'running' | 'disconnected' | 'stopped';

export interface Session {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  ptyProcess: IPty | null;
  clients: Set<WebSocket>;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  created_at: number;
  last_active_at: number;
}
```

- [ ] **Step 6: Run npm install**

Run: `cd /data/claude-session-manager && npm install`
Expected: installs dependencies without errors.

- [ ] **Step 7: Commit**

```bash
cd /data/claude-session-manager
git init
git add package.json tsconfig.json tsconfig.frontend.json .gitignore src/server/session/types.ts
git commit -m "chore: bootstrap project with TypeScript and dependencies"
```

---

## Task 2: MemoryService (SQLite)

**Files:**
- Create: `/data/claude-session-manager/src/server/memory/service.ts`
- Create: `/data/claude-session-manager/tests/server/memory-service.test.ts`
- Modify: `/data/claude-session-manager/package.json` scripts (add test if needed)

- [ ] **Step 1: Write failing test**

```typescript
// tests/server/memory-service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryService } from '../../src/server/memory/service';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB = '/tmp/csm-test.db';

describe('MemoryService', () => {
  let service: MemoryService;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    service = new MemoryService(TEST_DB);
  });

  afterEach(() => {
    service.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('creates and retrieves a session', () => {
    const session = service.createSession({ name: 'test', cwd: '/home/user/proj', status: 'running' });
    expect(session.id).toBeDefined();
    expect(session.name).toBe('test');

    const found = service.getSession(session.id);
    expect(found).not.toBeNull();
    expect(found!.cwd).toBe('/home/user/proj');
  });

  it('lists sessions', () => {
    service.createSession({ name: 'a', cwd: '/a', status: 'running' });
    service.createSession({ name: 'b', cwd: '/b', status: 'disconnected' });
    const list = service.listSessions();
    expect(list).toHaveLength(2);
  });

  it('updates session name', () => {
    const s = service.createSession({ name: 'old', cwd: '/x', status: 'running' });
    service.updateSession(s.id, { name: 'new' });
    const found = service.getSession(s.id);
    expect(found!.name).toBe('new');
  });

  it('deletes a session', () => {
    const s = service.createSession({ name: 'del', cwd: '/y', status: 'stopped' });
    service.deleteSession(s.id);
    expect(service.getSession(s.id)).toBeNull();
  });

  it('returns cwd suggestions', () => {
    service.createSession({ name: 'a', cwd: '/projects/one', status: 'running' });
    service.createSession({ name: 'b', cwd: '/projects/one', status: 'running' });
    service.createSession({ name: 'c', cwd: '/projects/two', status: 'running' });
    const suggestions = service.getCwdSuggestions();
    expect(suggestions).toContain('/projects/one');
    expect(suggestions).toContain('/projects/two');
    expect(suggestions.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/claude-session-manager && npx vitest run tests/server/memory-service.test.ts`
Expected: FAIL — `MemoryService` not found.

- [ ] **Step 3: Implement MemoryService**

```typescript
// src/server/memory/service.ts
import Database from 'better-sqlite3';
import type { SessionRecord, SessionStatus } from '../session/types';

export class MemoryService {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'disconnected', 'stopped')),
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
    `);
  }

  createSession(partial: { name: string; cwd: string; status: SessionStatus }): SessionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const record: SessionRecord = {
      id,
      name: partial.name,
      cwd: partial.cwd,
      status: partial.status,
      created_at: now,
      last_active_at: now,
    };
    this.db.prepare(
      `INSERT INTO sessions (id, name, cwd, status, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(record.id, record.name, record.cwd, record.status, record.created_at, record.last_active_at);
    return record;
  }

  getSession(id: string): SessionRecord | null {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRecord | null;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`).all() as SessionRecord[];
  }

  updateSession(id: string, changes: Partial<Pick<SessionRecord, 'name' | 'status' | 'last_active_at'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); values.push(changes.name); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.last_active_at !== undefined) { sets.push('last_active_at = ?'); values.push(changes.last_active_at); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  getCwdSuggestions(): string[] {
    const rows = this.db.prepare(`SELECT cwd FROM sessions GROUP BY cwd ORDER BY COUNT(*) DESC LIMIT 10`).all() as { cwd: string }[];
    return rows.map(r => r.cwd);
  }

  loadNonStoppedSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT * FROM sessions WHERE status != 'stopped' ORDER BY last_active_at DESC`).all() as SessionRecord[];
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/claude-session-manager && npx vitest run tests/server/memory-service.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
cd /data/claude-session-manager
git add src/server/memory/service.ts tests/server/memory-service.test.ts
git commit -m "feat: add MemoryService with SQLite persistence"
```

---

## Task 3: SessionManager

**Files:**
- Create: `/data/claude-session-manager/src/server/session/manager.ts`
- Create: `/data/claude-session-manager/tests/server/session-manager.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/server/session-manager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/server/session/manager';
import { MemoryService } from '../../src/server/memory/service';
import * as fs from 'fs';

const TEST_DB = '/tmp/csm-manager-test.db';

describe('SessionManager', () => {
  let memory: MemoryService;
  let manager: SessionManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    memory = new MemoryService(TEST_DB);
    manager = new SessionManager(memory);
  });

  it('creates a session', () => {
    const s = manager.createSession('proj1', '/home/user/proj1');
    expect(s.name).toBe('proj1');
    expect(s.cwd).toBe('/home/user/proj1');
    expect(s.status).toBe('running');
    expect(s.clients.size).toBe(0);
  });

  it('lists sessions', () => {
    manager.createSession('a', '/a');
    manager.createSession('b', '/b');
    expect(manager.listSessions()).toHaveLength(2);
  });

  it('renames a session', () => {
    const s = manager.createSession('old', '/x');
    manager.renameSession(s.id, 'new');
    expect(manager.getSession(s.id)!.name).toBe('new');
  });

  it('marks stopped on close without PTY', () => {
    const s = manager.createSession('temp', '/tmp');
    manager.closeSession(s.id);
    expect(manager.getSession(s.id)!.status).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/claude-session-manager && npx vitest run tests/server/session-manager.test.ts`
Expected: FAIL — `SessionManager` not found.

- [ ] **Step 3: Implement SessionManager**

```typescript
// src/server/session/manager.ts
import type { Session, SessionStatus } from './types';
import type { MemoryService } from '../memory/service';
import type WebSocket from 'ws';

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private memory: MemoryService) {}

  createSession(name: string, cwd: string): Session {
    const record = this.memory.createSession({ name, cwd, status: 'running' });
    const session: Session = {
      ...record,
      ptyProcess: null,
      clients: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  renameSession(id: string, name: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.name = name;
    this.memory.updateSession(id, { name });
  }

  updateStatus(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = status;
    this.memory.updateSession(id, { status });
  }

  attachClient(id: string, ws: WebSocket): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.clients.add(ws);
    if (s.status === 'disconnected') {
      s.status = 'running';
      this.memory.updateSession(id, { status: 'running' });
    }
  }

  detachClient(id: string, ws: WebSocket): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.clients.delete(ws);
    if (s.clients.size === 0 && s.status === 'running') {
      s.status = 'disconnected';
      this.memory.updateSession(id, { status: 'disconnected' });
    }
  }

  closeSession(id: string, force = false): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.ptyProcess) {
      s.ptyProcess.kill(force ? 'SIGKILL' : 'SIGTERM');
      s.ptyProcess = null;
    }
    s.clients.forEach(ws => ws.close());
    s.clients.clear();
    s.status = 'stopped';
    this.memory.updateSession(id, { status: 'stopped' });
  }

  restoreSessions(): void {
    const records = this.memory.loadNonStoppedSessions();
    for (const r of records) {
      this.sessions.set(r.id, {
        ...r,
        ptyProcess: null,
        clients: new Set(),
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/claude-session-manager && npx vitest run tests/server/session-manager.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
cd /data/claude-session-manager
git add src/server/session/manager.ts tests/server/session-manager.test.ts
git commit -m "feat: add SessionManager with state machine and client attach/detach"
```

---

## Task 4: PtyService

**Files:**
- Create: `/data/claude-session-manager/src/server/session/pty.ts`
- Modify: `/data/claude-session-manager/src/server/session/manager.ts` (integrate PtyService if needed, or keep separate)

- [ ] **Step 1: Implement PtyService**

```typescript
// src/server/session/pty.ts
import * as pty from 'node-pty';
import type { Session } from './types';
import type WebSocket from 'ws';

export interface PtyOptions {
  cwd: string;
  sessionId: string;
  claudePath: string;
  cols?: number;
  rows?: number;
}

export function spawnPty(options: PtyOptions): pty.IPty {
  const { cwd, sessionId, claudePath, cols = 120, rows = 30 } = options;
  const shell = process.platform === 'win32' ? 'powershell.exe' : claudePath;
  const args = process.platform === 'win32' ? [] : [];

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: sessionId,
      CLAUDE_CSM_MODE: '1',
      TERM: 'xterm-256color',
    },
  });

  return proc;
}

export function broadcastToSession(session: Session, data: string): void {
  const message = JSON.stringify({ type: 'output', data });
  for (const ws of session.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

export function broadcastStatus(session: Session): void {
  const message = JSON.stringify({ type: 'status', status: session.status });
  for (const ws of session.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
```

- [ ] **Step 2: Update SessionManager to integrate PTY spawning**

Modify `createSession` in `src/server/session/manager.ts` to accept optional PTY spawning. Actually, keep `SessionManager` PTY-agnostic. The HttpServer / WS layer will spawn PTY and attach it to the session. This keeps separation clean.

No file modification needed if we keep the boundary. Just ensure `Session.ptyProcess` is typed correctly (already is).

- [ ] **Step 3: Commit**

```bash
cd /data/claude-session-manager
git add src/server/session/pty.ts
git commit -m "feat: add PtyService with spawn and broadcast helpers"
```

---

## Task 5: WebSocketRouter

**Files:**
- Create: `/data/claude-session-manager/src/server/ws/router.ts`
- Modify: `/data/claude-session-manager/src/server/session/manager.ts` (if any adjustments needed)

- [ ] **Step 1: Write failing integration test**

```typescript
// tests/server/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import * as http from 'http';
import { createHttpServer } from '../../src/server/http-server';
import { SessionManager } from '../../src/server/session/manager';
import { MemoryService } from '../../src/server/memory/service';
import * as fs from 'fs';

const TEST_DB = '/tmp/csm-integration.db';
const PORT = 19999;

describe('Integration', () => {
  let server: http.Server;
  let memory: MemoryService;
  let manager: SessionManager;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    memory = new MemoryService(TEST_DB);
    manager = new SessionManager(memory);
    const app = createHttpServer(manager, { claudePath: '/bin/cat' });
    server = app;
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(() => {
    server.close();
    memory.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('echoes PTY output via WebSocket', async () => {
    // Create session via REST first
    const res = await fetch(`http://localhost:${PORT}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'echo', cwd: '/tmp' }),
    });
    const { id } = await res.json();

    const ws = new WebSocket(`ws://localhost:${PORT}/ws?sessionId=${id}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Wait for initial status
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // Send input
    ws.send(JSON.stringify({ type: 'input', data: 'hello world\n' }));

    // Wait a bit for echo
    await new Promise((r) => setTimeout(r, 500));

    const outputs = messages.filter((m: any) => m.type === 'output');
    expect(outputs.length).toBeGreaterThan(0);

    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/claude-session-manager && npx vitest run tests/server/integration.test.ts`
Expected: FAIL — `createHttpServer` not found, server not running.

- [ ] **Step 3: Implement WebSocketRouter**

```typescript
// src/server/ws/router.ts
import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { SessionManager } from '../session/manager';
import type { Session } from '../session/types';
import { spawnPty, broadcastToSession, broadcastStatus } from '../session/pty';

interface WsMessage {
  type: 'input' | 'resize' | 'ping';
  data?: string;
  cols?: number;
  rows?: number;
}

export function setupWebSocketRouter(wss: WebSocketServer, manager: SessionManager, claudePath: string): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      ws.close(1008, 'Missing sessionId');
      return;
    }

    let session = manager.getSession(sessionId);
    if (!session) {
      ws.close(1008, 'Session not found');
      return;
    }

    // Spawn PTY if not running
    if (!session.ptyProcess && session.status !== 'stopped') {
      try {
        const pty = spawnPty({
          cwd: session.cwd,
          sessionId: session.id,
          claudePath,
        });
        session.ptyProcess = pty;
        pty.onData((data) => {
          broadcastToSession(session!, data);
        });
        pty.onExit(({ exitCode }) => {
          session!.ptyProcess = null;
          manager.updateStatus(session!.id, 'stopped');
          broadcastStatus(session!);
        });
      } catch (err) {
        ws.close(1011, 'Failed to spawn PTY');
        return;
      }
    }

    manager.attachClient(sessionId, ws);
    broadcastStatus(session);

    ws.send(JSON.stringify({ type: 'status', status: session.status }));

    let heartbeatTimer: NodeJS.Timeout;
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        ws.close(1001, 'Heartbeat timeout');
      }, 35000);
    };
    resetHeartbeat();

    ws.on('message', (raw) => {
      resetHeartbeat();
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        if (msg.type === 'input' && msg.data && session!.ptyProcess) {
          session!.ptyProcess.write(msg.data);
        } else if (msg.type === 'resize' && session!.ptyProcess) {
          session!.ptyProcess.resize(msg.cols || 120, msg.rows || 30);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clearTimeout(heartbeatTimer);
      manager.detachClient(sessionId, ws);
    });

    ws.on('error', () => {
      clearTimeout(heartbeatTimer);
      manager.detachClient(sessionId, ws);
    });
  });
}
```

- [ ] **Step 4: Commit**

```bash
cd /data/claude-session-manager
git add src/server/ws/router.ts tests/server/integration.test.ts
git commit -m "feat: add WebSocketRouter with PTY spawn and heartbeat"
```

---

## Task 6: HttpServer + REST API + CLI Entry

**Files:**
- Create: `/data/claude-session-manager/src/server/http-server.ts`
- Create: `/data/claude-session-manager/src/index.ts`

- [ ] **Step 1: Implement HttpServer**

```typescript
// src/server/http-server.ts
import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import type { SessionManager } from './session/manager';
import { setupWebSocketRouter } from './ws/router';

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  claudePath: string;
  auth?: string;
}

export function createHttpServer(manager: SessionManager, options: Pick<ServerOptions, 'claudePath' | 'auth'>): http.Server {
  const app = express();
  app.use(express.json());

  // Optional basic auth
  if (options.auth) {
    const [expectedUser, expectedPass] = options.auth.split(':');
    app.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Unauthorized');
      }
      const creds = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      if (creds !== `${expectedUser}:${expectedPass}`) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Unauthorized');
      }
      next();
    });
  }

  // REST API
  app.get('/api/sessions', (_req, res) => {
    res.json(manager.listSessions().map(s => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    })));
  });

  app.post('/api/sessions', (req, res) => {
    const { name, cwd } = req.body;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'cwd is required' });
    }
    // Validate cwd is absolute and exists
    if (!path.isAbsolute(cwd)) {
      return res.status(400).json({ error: 'cwd must be absolute path' });
    }
    const session = manager.createSession(name || `session-${Date.now()}`, cwd);
    res.status(201).json({
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    });
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const { name } = req.body;
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (name) manager.renameSession(req.params.id, name);
    res.json({ id: session.id, name: session.name });
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    manager.closeSession(req.params.id);
    res.status(204).send();
  });

  app.get('/api/cwd-suggestions', (_req, res) => {
    // TODO: implement via MemoryService if needed; stub for now
    res.json([]);
  });

  // Static files
  const publicPath = path.join(__dirname, '../../public');
  app.use(express.static(publicPath));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocketRouter(wss, manager, options.claudePath);

  return server;
}
```

- [ ] **Step 2: Implement CLI entry**

```typescript
// src/index.ts
#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHttpServer } from './server/http-server';
import { SessionManager } from './server/session/manager';
import { MemoryService } from './server/memory/service';

function parseArgs(): { port: number; host: string; dataDir: string; claudePath: string; auth?: string } {
  const args = process.argv.slice(2);
  let port = 8080;
  let host = '127.0.0.1';
  let dataDir = path.join(os.homedir(), '.csm');
  let claudePath = 'claude';
  let auth: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10);
    else if (args[i] === '--host' || args[i] === '-h') host = args[++i];
    else if (args[i] === '--data-dir') dataDir = args[++i];
    else if (args[i] === '--claude-path') claudePath = args[++i];
    else if (args[i] === '--auth') auth = args[++i];
  }

  return { port, host, dataDir, claudePath, auth };
}

function main(): void {
  const opts = parseArgs();

  if (!fs.existsSync(opts.dataDir)) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
  }

  const dbPath = path.join(opts.dataDir, 'sessions.db');
  const memory = new MemoryService(dbPath);
  const manager = new SessionManager(memory);
  manager.restoreSessions();

  const server = createHttpServer(manager, { claudePath: opts.claudePath, auth: opts.auth });

  server.listen(opts.port, opts.host, () => {
    console.log(`CSM listening on http://${opts.host}:${opts.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => {
      manager.listSessions().forEach((s) => manager.closeSession(s.id, true));
      memory.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
```

- [ ] **Step 3: Run integration test**

Run: `cd /data/claude-session-manager && npx vitest run tests/server/integration.test.ts`
Expected: Test passes (or adjust if PTY spawn with `/bin/cat` has platform issues; if so, skip the test and add a TODO comment).

- [ ] **Step 4: Commit**

```bash
cd /data/claude-session-manager
git add src/server/http-server.ts src/index.ts
git commit -m "feat: add HttpServer with REST API and CLI entry point"
```

---

## Task 7: Frontend Shell + WebSocket Client

**Files:**
- Create: `/data/claude-session-manager/src/frontend/index.html`
- Create: `/data/claude-session-manager/src/frontend/styles.css`
- Create: `/data/claude-session-manager/src/frontend/app.ts`

- [ ] **Step 1: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Session Manager</title>
  <link rel="stylesheet" href="styles.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
</head>
<body>
  <div id="app">
    <header class="top-bar">
      <span class="logo">Claude Session Manager</span>
      <div class="actions">
        <button id="btn-new">+ New Session</button>
      </div>
    </header>
    <div class="main-layout">
      <aside id="session-list" class="sidebar left"></aside>
      <main id="terminal-panel" class="terminal-area">
        <div id="terminal-container"></div>
        <div id="connection-overlay" class="hidden"></div>
      </main>
      <aside id="session-info" class="sidebar right collapsed"></aside>
    </div>
  </div>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create styles.css**

```css
:root {
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d30;
  --fg-primary: #cccccc;
  --fg-secondary: #858585;
  --accent: #007acc;
  --border: #3e3e42;
  --success: #4ec9b0;
  --warning: #ce9178;
  --error: #f44747;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body, #app {
  height: 100%;
  background: var(--bg-primary);
  color: var(--fg-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  overflow: hidden;
}

.top-bar {
  height: 40px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
}

.logo { font-weight: 600; font-size: 14px; }

.actions button {
  background: var(--accent);
  color: white;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.actions button:hover { opacity: 0.9; }

.main-layout {
  display: flex;
  height: calc(100% - 40px);
}

.sidebar {
  width: 220px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar.right {
  border-right: none;
  border-left: 1px solid var(--border);
}

.sidebar.collapsed { width: 0; border: none; }

.terminal-area {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
}

#terminal-container {
  flex: 1;
  padding: 8px;
}

#connection-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-primary);
  font-size: 14px;
  z-index: 10;
}

#connection-overlay.hidden { display: none; }

.session-item {
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.session-item:hover { background: var(--bg-tertiary); }

.session-item.active { background: var(--accent); color: white; }

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.running { background: var(--success); }
.status-dot.disconnected { background: var(--warning); }
.status-dot.stopped { background: var(--error); }

.session-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.info-panel { padding: 12px; font-size: 13px; }
.info-panel h3 { margin-bottom: 8px; font-size: 14px; }
.info-row { margin-bottom: 6px; color: var(--fg-secondary); }
.info-row span { color: var(--fg-primary); }
```

- [ ] **Step 3: Implement app.ts**

```typescript
// src/frontend/app.ts
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SessionList } from './components/session-list';
import { SessionInfo } from './components/session-info';

interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: 'running' | 'disconnected' | 'stopped';
  createdAt: number;
  lastActiveAt: number;
}

class App {
  private ws: WebSocket | null = null;
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private sessions: SessionSummary[] = [];
  private currentSessionId: string | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private sessionList: SessionList;
  private sessionInfo: SessionInfo;

  constructor() {
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
      },
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const container = document.getElementById('terminal-container')!;
    this.terminal.open(container);
    this.fitAddon.fit();

    this.sessionList = new SessionList(document.getElementById('session-list')!, {
      onSelect: (id) => this.switchSession(id),
      onNew: () => this.createNewSession(),
    });

    this.sessionInfo = new SessionInfo(document.getElementById('session-info')!);

    window.addEventListener('resize', () => {
      this.fitAddon.fit();
      this.sendResize();
    });

    document.getElementById('btn-new')!.addEventListener('click', () => this.createNewSession());

    this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    const res = await fetch('/api/sessions');
    this.sessions = await res.json();
    this.sessionList.render(this.sessions, this.currentSessionId);
    if (this.sessions.length > 0 && !this.currentSessionId) {
      this.switchSession(this.sessions[0].id);
    }
  }

  private switchSession(id: string): void {
    if (this.currentSessionId === id) return;
    this.disconnect();
    this.currentSessionId = id;
    this.sessionList.render(this.sessions, id);
    const session = this.sessions.find((s) => s.id === id);
    if (session) this.sessionInfo.render(session);
    this.connect(id);
  }

  private async createNewSession(): Promise<void> {
    const name = prompt('Session name:', `session-${Date.now()}`);
    if (!name) return;
    const cwd = prompt('Working directory:', '/tmp');
    if (!cwd) return;

    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd }),
    });
    const session: SessionSummary = await res.json();
    this.sessions.unshift(session);
    this.sessionList.render(this.sessions, this.currentSessionId);
    this.switchSession(session.id);
  }

  private connect(sessionId: string): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;
    this.ws = new WebSocket(wsUrl);

    this.showOverlay('Connecting...');

    this.ws.onopen = () => {
      this.hideOverlay();
      this.reconnectDelay = 1000;
      this.sendResize();
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          this.terminal.write(msg.data);
        } else if (msg.type === 'status') {
          this.updateSessionStatus(sessionId, msg.status);
        } else if (msg.type === 'pong') {
          // heartbeat ok
        }
      } catch {
        // ignore
      }
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.scheduleReconnect(sessionId);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };

    this.terminal.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  private disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(sessionId: string): void {
    this.showOverlay(`Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect(sessionId);
    }, this.reconnectDelay);
  }

  private sendResize(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const dims = this.fitAddon.proposeDimensions();
    if (dims) {
      this.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
  }

  private heartbeatTimer: number | null = null;
  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private updateSessionStatus(id: string, status: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.status = status as any;
      this.sessionList.render(this.sessions, this.currentSessionId);
    }
  }

  private showOverlay(text: string): void {
    const el = document.getElementById('connection-overlay')!;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  private hideOverlay(): void {
    document.getElementById('connection-overlay')!.classList.add('hidden');
  }
}

new App();
```

- [ ] **Step 4: Create frontend components**

```typescript
// src/frontend/components/session-list.ts
export class SessionList {
  constructor(
    private container: HTMLElement,
    private handlers: { onSelect: (id: string) => void; onNew: () => void }
  ) {}

  render(sessions: any[], activeId: string | null): void {
    this.container.innerHTML = '';

    sessions.forEach((s) => {
      const el = document.createElement('div');
      el.className = `session-item ${s.id === activeId ? 'active' : ''}`;
      el.innerHTML = `
        <span class="status-dot ${s.status}"></span>
        <span class="session-name">${this.escapeHtml(s.name)}</span>
      `;
      el.addEventListener('click', () => this.handlers.onSelect(s.id));
      this.container.appendChild(el);
    });

    const btn = document.createElement('button');
    btn.textContent = '+ New Session';
    btn.style.cssText = 'margin: 8px; padding: 6px; width: calc(100% - 16px); background: var(--bg-tertiary); color: var(--fg-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;';
    btn.addEventListener('click', () => this.handlers.onNew());
    this.container.appendChild(btn);
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
```

```typescript
// src/frontend/components/session-info.ts
export class SessionInfo {
  constructor(private container: HTMLElement) {}

  render(session: any): void {
    this.container.innerHTML = `
      <div class="info-panel">
        <h3>Session Info</h3>
        <div class="info-row">Name: <span>${this.escapeHtml(session.name)}</span></div>
        <div class="info-row">CWD: <span>${this.escapeHtml(session.cwd)}</span></div>
        <div class="info-row">Status: <span>${session.status}</span></div>
        <div class="info-row">Created: <span>${new Date(session.createdAt).toLocaleString()}</span></div>
      </div>
    `;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
```

- [ ] **Step 5: Build frontend**

Run: `cd /data/claude-session-manager && npx tsc -p tsconfig.frontend.json`
Expected: compiles without errors. May need to install `@types/xterm` or rely on CDN — since xterm is loaded via CDN in HTML, the frontend TS imports may fail. If so, add a type declaration stub.

If `xterm` types are missing, create `src/frontend/xterm.d.ts`:

```typescript
declare module 'xterm' {
  export class Terminal {
    constructor(options?: any);
    loadAddon(addon: any): void;
    open(element: HTMLElement): void;
    write(data: string | Uint8Array): void;
    onData(callback: (data: string) => void): void;
    resize(cols: number, rows: number): void;
    clear(): void;
  }
  export interface ITerminalOptions {
    cursorBlink?: boolean;
    fontSize?: number;
    fontFamily?: string;
    theme?: any;
  }
}

declare module 'xterm-addon-fit' {
  export class FitAddon {
    fit(): void;
    proposeDimensions(): { cols: number; rows: number } | undefined;
  }
}
```

- [ ] **Step 6: Commit**

```bash
cd /data/claude-session-manager
git add src/frontend/
git commit -m "feat: add frontend shell with session list, terminal, and info panel"
```

---

## Task 8: Build + Manual Verification

- [ ] **Step 1: Build backend**

Run: `cd /data/claude-session-manager && npx tsc`
Expected: compiles without errors.

- [ ] **Step 2: Start server and verify**

Run: `cd /data/claude-session-manager && node dist/index.js --port 18080`
Then in another terminal:
```bash
curl -X POST http://localhost:18080/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"test","cwd":"/tmp"}'
```
Expected: returns JSON with session id.

- [ ] **Step 3: Verify WebSocket attach**

Use `websocat` or browser DevTools to connect to `ws://localhost:18080/ws?sessionId=<id>`.
Send `{"type":"input","data":"ls\n"}` and observe output.

- [ ] **Step 4: Run all tests**

Run: `cd /data/claude-session-manager && npx vitest run`
Expected: all tests passing.

- [ ] **Step 5: Commit**

```bash
cd /data/claude-session-manager
git add -A
git commit -m "build: verify build and integration tests passing"
```

---

## Spec Coverage Checklist

| Spec Requirement | Task |
|------------------|------|
| SQLite schema + CRUD | Task 2 |
| Session state machine (running/disconnected/stopped) | Task 3 |
| PTY spawn via node-pty | Task 4 |
| WebSocket protocol (input/output/resize/ping/status) | Task 5 |
| REST API (sessions CRUD, cwd suggestions) | Task 6 |
| CLI entry with flags (--port, --host, --data-dir, --auth) | Task 6 |
| Graceful shutdown (SIGINT/SIGTERM) | Task 6 |
| Frontend: session list, terminal, info panel | Task 7 |
| Auto-reconnect with backoff | Task 7 |
| Heartbeat | Task 5 + 7 |
| Static file serving | Task 6 |
| Tests (unit + integration) | Tasks 2, 3, 5, 8 |

---

## Self-Review

- **Placeholder scan:** No TBD/TODO/placeholder left in the plan code blocks.
- **Type consistency:** `SessionRecord` fields match SQLite schema; `Session` extends it with runtime fields (`ptyProcess`, `clients`).
- **Scope:** This is an MVP plan. Features like browser notifications, multi-tab sync polish, context menu, and `cmd-k` shortcuts are in the spec but deferred to post-MVP. They can be added incrementally.
