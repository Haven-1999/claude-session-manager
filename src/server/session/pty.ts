import * as pty from 'node-pty';
import type { Session } from './types';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync, spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

let resolvedClaudePath: string | null = null;

function resolveClaudePath(claudePath: string): string {
  if (path.isAbsolute(claudePath)) return claudePath;
  if (resolvedClaudePath) return resolvedClaudePath;

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
    '/usr/bin/' + claudePath,
    '/opt/homebrew/bin/' + claudePath,
  ];

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

export interface PtyHandle {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (exit: { exitCode: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  pid: number;
}

function cleanPath(rawPath: string | undefined): string {
  if (!rawPath) return '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return rawPath
    .split(':')
    .filter(p => !p.includes('node_modules/.bin'))
    .join(':');
}

let nodePtyWorks: boolean | null = null;

function testNodePty(): boolean {
  if (nodePtyWorks !== null) return nodePtyWorks;
  try {
    const testProc = pty.spawn('/bin/echo', ['test'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' },
    });
    testProc.kill();
    nodePtyWorks = true;
    console.log('[CSM PTY] node-pty: OK');
  } catch {
    nodePtyWorks = false;
    console.warn('[CSM PTY] node-pty: FAILED, will use script-based fallback');
  }
  return nodePtyWorks;
}

class ScriptPtyHandle extends EventEmitter implements PtyHandle {
  private proc: ChildProcess;
  readonly pid: number;

  constructor(shell: string, shellArgs: string[], options: {
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  }) {
    super();
    // Use Python pty module to create a real PTY (works on macOS 26+)
    const helperPath = path.join(__dirname, '../../../scripts/pty-helper.py');
    this.proc = spawn('python3', [helperPath, shell, ...shellArgs], {
      cwd: options.cwd,
      env: { ...options.env, COLUMNS: String(options.cols), LINES: String(options.rows) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.pid = this.proc.pid!;
    console.log(`[CSM PTY] python-pty-fallback spawned, pid=${this.pid}`);
  }

  onData(cb: (data: string) => void): void {
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      const str = stdoutDecoder.write(chunk);
      if (str) cb(str);
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const str = stderrDecoder.write(chunk);
      if (str) cb(str);
    });
  }

  onExit(cb: (exit: { exitCode: number }) => void): void {
    this.proc.on('exit', (code) => cb({ exitCode: code ?? 1 }));
  }

  write(data: string): void {
    this.proc.stdin?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc.stdin?.write(`\x1b]9999;${cols}x${rows}\x07`);
  }

  kill(signal?: string): void {
    this.proc.kill(signal as NodeJS.Signals || 'SIGTERM');
  }
}

function buildSpawnEnv(cleanedPath: string): Record<string, string> {
  const shell = process.env.SHELL || '/bin/zsh';
  return {
    HOME: process.env.HOME || os.homedir(),
    USER: process.env.USER || '',
    SHELL: shell,
    PATH: cleanedPath,
    CLAUDE_CSM_MODE: '1',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };
}

export function spawnPty(options: PtyOptions): PtyHandle {
  const { cwd, claudePath, cols = 120, rows = 30, resumeClaudeId } = options;
  const resolved = process.platform === 'win32' ? 'powershell.exe' : resolveClaudePath(claudePath);
  const args = resumeClaudeId ? ['--resume', resumeClaudeId] : [];
  const cleanedPath = cleanPath(process.env.PATH);
  const shell = process.env.SHELL || '/bin/zsh';
  const spawnEnv = buildSpawnEnv(cleanedPath);

  console.log(`[CSM PTY] spawn: ${resolved} ${args.join(' ')} in ${cwd} (${cols}x${rows}) resume=${!!resumeClaudeId}`);

  // Pre-flight checks
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statSync(resolved);
      const isExecutable = !!(stat.mode & 0o111);
      if (stat.size === 0) throw new Error(`Claude binary is empty (0 bytes): ${resolved}`);
      if (!isExecutable) throw new Error(`Claude binary is not executable: ${resolved}`);
    } catch (e: any) {
      if (e.code === 'ENOENT') throw new Error(`Claude binary not found: ${resolved}`);
      throw e;
    }
    if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const cmdParts = [resolved, ...args].map(a => a.replace(/'/g, "'\\''")).map(a => `'${a}'`).join(' ');
  const spawnCmd = `exec ${cmdParts}`;

  // Try node-pty first
  if (testNodePty()) {
    console.log(`[CSM PTY] using node-pty`);
    const proc = pty.spawn(shell, ['-lc', spawnCmd], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      encoding: 'utf8',
      env: spawnEnv,
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

  // Fallback: use macOS `script` command for PTY allocation
  console.log(`[CSM PTY] using script-based fallback`);
  return new ScriptPtyHandle(shell, ['-lc', spawnCmd], { cwd, env: spawnEnv, cols, rows });
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
