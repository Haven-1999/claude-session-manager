import * as pty from 'node-pty';
import type { Session } from './types';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';

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

  // Pre-flight checks
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statSync(resolved);
      const isExecutable = !!(stat.mode & 0o111);
      console.log(`[CSM PTY] file check: exists=${true} size=${stat.size} executable=${isExecutable} isSymlink=${fs.lstatSync(resolved).isSymbolicLink()}`);
      if (stat.size === 0) {
        throw new Error(`Claude binary is empty (0 bytes): ${resolved}`);
      }
      if (!isExecutable) {
        throw new Error(`Claude binary is not executable: ${resolved}`);
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        throw new Error(`Claude binary not found: ${resolved}`);
      }
      throw e;
    }
    // Check if cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
  }

  const shell = process.env.SHELL || '/bin/zsh';
  const spawnEnv: Record<string, string> = {
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || '',
    SHELL: shell,
    PATH: cleanedPath,
    CLAUDE_CSM_MODE: '1',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };

  // Debug: print full spawn parameters
  const cmdParts = [resolved, ...args].map(a => a.replace(/'/g, "'\\''")).map(a => `'${a}'`).join(' ');
  const spawnCmd = `exec ${cmdParts}`;
  console.log(`[CSM PTY] shell: ${shell} (exists=${fs.existsSync(shell)})`);
  console.log(`[CSM PTY] spawnCmd: ${spawnCmd}`);
  console.log(`[CSM PTY] env:`, JSON.stringify(spawnEnv));
  console.log(`[CSM PTY] cwd: ${cwd} (accessible=${(() => { try { fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK); return true; } catch { return false; } })()})`);

  // Diagnostic: test child_process.spawn (no PTY) to isolate the issue
  try {
    const cpResult = spawnSync('/bin/echo', ['cp-test-ok'], { encoding: 'utf8', timeout: 3000 });
    console.log(`[CSM PTY] diagnostic child_process.spawnSync: status=${cpResult.status} stdout=${cpResult.stdout?.trim()} error=${cpResult.error?.message || 'none'}`);
  } catch (cpErr: any) {
    console.error(`[CSM PTY] diagnostic child_process FAILED:`, cpErr.message);
  }

  // Diagnostic: check system PTY/fd limits
  try {
    const ulimitResult = spawnSync('/bin/sh', ['-c', 'ulimit -n'], { encoding: 'utf8', timeout: 3000 });
    const ptmxExists = fs.existsSync('/dev/ptmx');
    console.log(`[CSM PTY] system: ulimit-n=${ulimitResult.stdout?.trim()} /dev/ptmx=${ptmxExists}`);
  } catch { /* ignore */ }

  // Diagnostic: check node-pty native addon
  try {
    const ptyNativePath = require.resolve('node-pty/build/Release/pty.node');
    const ptyNativeStat = fs.statSync(ptyNativePath);
    console.log(`[CSM PTY] native addon: path=${ptyNativePath} size=${ptyNativeStat.size}`);
  } catch (e: any) {
    console.error(`[CSM PTY] native addon NOT FOUND:`, e.message);
  }

  // Diagnostic: try spawning a minimal command via node-pty
  try {
    const testProc = pty.spawn('/bin/echo', ['pty-test-ok'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' },
    });
    console.log(`[CSM PTY] diagnostic pty.spawn /bin/echo succeeded, pid=${(testProc as any).pid}`);
    testProc.kill();
  } catch (diagErr: any) {
    console.error(`[CSM PTY] diagnostic pty.spawn /bin/echo FAILED:`, diagErr.message);
  }

  try {
    const proc = pty.spawn(shell, ['-lc', spawnCmd], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      encoding: 'utf8',
      env: spawnEnv,
    });

    return proc;
  } catch (err: any) {
    console.error(`[CSM PTY] spawn failed: ${err.message}`);
    console.error(`[CSM PTY] spawn details: shell=${shell} args=['-lc', '${spawnCmd}'] cwd=${cwd}`);
    console.error(`[CSM PTY] node-pty version:`, require('node-pty/package.json').version);
    console.error(`[CSM PTY] node version: ${process.version}, platform: ${process.platform}, arch: ${process.arch}`);
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
