import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import * as os from 'os';
import type { SessionManager } from '../session/manager';

interface ShellMessage {
  type: 'input' | 'resize' | 'ping';
  data?: string;
  cols?: number;
  rows?: number;
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || os.userInfo().shell || '/bin/sh';
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

    let shellProcess: pty.IPty | null = null;

    try {
      shellProcess = pty.spawn(defaultShell(), [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: session.cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
        },
      });
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
