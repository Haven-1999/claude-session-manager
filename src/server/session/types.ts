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
  tagId: string;
  outputBuffer: string[];
  outputBufferStartIndex: number;
}

export interface SessionRecord {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  created_at: number;
  last_active_at: number;
  claude_session_id?: string | null;
  tag_id: string;
}

export interface Tag {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
}

export interface TagRecord {
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

export const UNCATEGORIZED_TAG_ID = 'uncategorized';
