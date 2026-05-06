import * as pty from 'node-pty';
import type { Session } from './types';
import WebSocket from 'ws';

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
  console.log(`[CSM PTY] spawn: ${shell} ${args.join(' ')} in ${cwd} (${cols}x${rows})`);

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: sessionId,
      CLAUDE_CSM_MODE: '1',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
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
