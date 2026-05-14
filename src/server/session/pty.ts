import * as pty from 'node-pty';
import type { Session } from './types';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

let resolvedClaudePath: string | null = null;

function resolveClaudePath(claudePath: string): string {
  if (path.isAbsolute(claudePath)) return claudePath;
  if (resolvedClaudePath) return resolvedClaudePath;

  // Only allow simple command names to prevent injection
  if (!/^[a-zA-Z0-9._-]+$/.test(claudePath)) {
    console.warn(`[CSM PTY] Invalid claudePath "${claudePath}", using as-is`);
    return claudePath;
  }

  const userShell = process.env.SHELL || '/bin/zsh';
  try {
    const resolved = execFileSync(userShell, ['-lc', `which ${claudePath}`], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (resolved && fs.existsSync(resolved)) {
      console.log(`[CSM PTY] Resolved claude path via login shell: ${resolved}`);
      resolvedClaudePath = resolved;
      return resolved;
    }
  } catch {
    // login shell resolution failed
  }

  const candidates = [
    '/usr/local/bin/' + claudePath,
    '/opt/homebrew/bin/' + claudePath,
  ];

  // Scan nvm versions directories
  const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
  try {
    const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v')).sort().reverse();
    for (const v of versions) {
      candidates.push(path.join(nvmDir, v, 'bin', claudePath));
    }
  } catch {
    // nvm not installed
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[CSM PTY] Resolved claude path via fallback scan: ${candidate}`);
      resolvedClaudePath = candidate;
      return candidate;
    }
  }

  console.warn(`[CSM PTY] Could not resolve absolute path for "${claudePath}", using as-is`);
  return claudePath;
}

export interface PtyOptions {
  cwd: string;
  sessionId: string;
  claudePath: string;
  cols?: number;
  rows?: number;
  resumeClaudeId?: string | null;
}

function cleanPath(rawPath: string | undefined): string {
  if (!rawPath) return '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return rawPath
    .split(':')
    .filter(p => !p.includes('node_modules/.bin'))
    .join(':');
}

export function spawnPty(options: PtyOptions): pty.IPty {
  const { cwd, sessionId, claudePath, cols = 120, rows = 30, resumeClaudeId } = options;
  const resolved = process.platform === 'win32' ? 'powershell.exe' : resolveClaudePath(claudePath);
  const args = resumeClaudeId ? ['--resume', resumeClaudeId] : [];
  const cleanedPath = cleanPath(process.env.PATH);
  console.log(`[CSM PTY] spawn: ${resolved} ${args.join(' ')} in ${cwd} (${cols}x${rows}) resume=${!!resumeClaudeId}`);
  console.log(`[CSM PTY] env: HOME=${process.env.HOME || ''} PATH=${cleanedPath} SHELL=${process.env.SHELL || ''}`);

  try {
    const proc = pty.spawn(resolved, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: cleanedPath,
        CLAUDE_CSM_MODE: '1',
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
    });

    return proc;
  } catch (err) {
    console.error('[CSM PTY] spawn failed', err);
    throw err;
  }
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
