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
  claudeSessionId?: string | null;
  outputBuffer: string[];
}

export interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  created_at: number;
  last_active_at: number;
  claude_session_id?: string | null;
}
