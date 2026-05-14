import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import * as os from 'os';
import type { SessionManager } from '../session/manager';
import type { PtyHandle } from '../session/pty';
import { spawn } from 'child_process';

interface ShellMessage {
  type: 'input' | 'resize' | 'ping';
  data?: string;
  cols?: number;
  rows?: number;
}

export function resolveShell(processShell = process.env.SHELL, userShell = os.userInfo().shell): string {
  if (process.platform === 'win32') return 'powershell.exe';
  if (userShell && processShell === '/bin/sh') return userShell;
  return processShell || userShell || '/bin/sh';
}

function shellArgs(shell: string): string[] {
  return shell.endsWith('/zsh') || shell.endsWith('/bash') ? ['-l'] : [];
}

let nodePtyWorks: boolean | null = null;

function checkNodePty(): boolean {
  if (nodePtyWorks !== null) return nodePtyWorks;
  try {
    const p = pty.spawn('/bin/echo', ['test'], {
      name: 'xterm-256color', cols: 80, rows: 24,
      cwd: os.homedir(),
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' },
    });
    p.kill();
    nodePtyWorks = true;
  } catch {
    nodePtyWorks = false;
  }
  return nodePtyWorks;
}

function spawnShellProcess(shell: string, args: string[], cwd: string, cols: number, rows: number): PtyHandle {
  if (checkNodePty()) {
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
    });
    return {
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit(cb),
      write: (data) => proc.write(data),
      resize: (c, r) => proc.resize(c, r),
      kill: (signal?: string) => proc.kill(signal),
      pid: (proc as any).pid,
    };
  }

  // Fallback: use macOS `script` for PTY
  console.log('[CSM Shell] using script-based fallback');
  const cp = spawn('/usr/bin/script', ['-q', '/dev/null', shell, ...args], {
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    onData: (cb) => {
      cp.stdout?.on('data', (chunk: Buffer) => cb(chunk.toString('utf8')));
      cp.stderr?.on('data', (chunk: Buffer) => cb(chunk.toString('utf8')));
    },
    onExit: (cb) => cp.on('exit', (code) => cb({ exitCode: code ?? 1 })),
    write: (data) => cp.stdin?.write(data),
    resize: () => {},
    kill: (signal?: string) => cp.kill(signal as NodeJS.Signals || 'SIGTERM'),
    pid: cp.pid!,
  };
}

export function setupShellWebSocketRouter(wss: WebSocketServer, manager: SessionManager): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      ws.close(1008, 'Missing sessionId');
      return;
    }

    const session = manager.getSession(sessionId);
    if (!session) {
      ws.close(1008, 'Session not found');
      return;
    }

    let shellProcess: PtyHandle | null = null;

    try {
      const shell = resolveShell();
      shellProcess = spawnShellProcess(shell, shellArgs(shell), session.cwd, 120, 30);
    } catch {
      ws.close(1011, 'Failed to spawn shell');
      return;
    }

    shellProcess.onData((data) => {
      manager.touch(session.id);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'output', data }));
      }
    });

    shellProcess.onExit(() => {
      shellProcess = null;
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, 'Shell exited');
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg: ShellMessage = JSON.parse(raw.toString());
        manager.touch(session.id);
        if (msg.type === 'input' && msg.data) {
          shellProcess?.write(msg.data);
        } else if (msg.type === 'resize') {
          shellProcess?.resize(msg.cols ?? 120, msg.rows ?? 30);
        } else if (msg.type === 'ping' && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore malformed messages.
      }
    });

    const cleanup = () => {
      if (shellProcess) {
        shellProcess.kill();
        shellProcess = null;
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
}
