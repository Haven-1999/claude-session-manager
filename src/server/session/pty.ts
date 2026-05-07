import * as pty from 'node-pty';
import type { Session } from './types';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface PtyOptions {
  cwd: string;
  sessionId: string;
  claudePath: string;
  cols?: number;
  rows?: number;
  resumeClaudeId?: string | null;
}

export function spawnPty(options: PtyOptions): pty.IPty {
  const { cwd, sessionId, claudePath, cols = 120, rows = 30, resumeClaudeId } = options;
  const shell = process.platform === 'win32' ? 'powershell.exe' : claudePath;
  const args = resumeClaudeId ? ['--resume', resumeClaudeId] : [];
  console.log(`[CSM PTY] spawn: ${shell} ${args.join(' ')} in ${cwd} (${cols}x${rows}) resume=${!!resumeClaudeId}`);

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CSM_MODE: '1',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
  });

  return proc;
}

export async function waitForClaudeSessionId(pid: number, timeoutMs = 10000): Promise<string | null> {
  const sessionDir = path.join(os.homedir(), '.claude', 'sessions');
  const sessionFile = path.join(sessionDir, `${pid}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = fs.readFileSync(sessionFile, 'utf8');
      const record = JSON.parse(data);
      if (record.sessionId) {
        console.log(`[CSM PTY] Found claude sessionId=${record.sessionId} for pid=${pid}`);
        return record.sessionId as string;
      }
    } catch {
      // file not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`[CSM PTY] Timeout waiting for claude sessionId, pid=${pid}`);
  return null;
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
