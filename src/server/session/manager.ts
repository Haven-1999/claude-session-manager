import type { Session, SessionStatus, Tag } from './types';
import { UNCATEGORIZED_TAG_ID } from './types';
import type { MemoryService } from '../memory/service';
import type WebSocket from 'ws';

export class SessionManager {
  private sessions = new Map<string, Session>();
  onStatusChange?: (id: string, status: SessionStatus) => void;

  constructor(private memory: MemoryService) {}

  // --- Tag methods ---

  createTag(name: string): Tag {
    return this.memory.createTag(name);
  }

  listTags(): Tag[] {
    return this.memory.listTags();
  }

  getTag(id: string): Tag | undefined {
    return this.memory.getTag(id);
  }

  updateTag(id: string, name: string): void {
    this.memory.updateTag(id, { name });
  }

  deleteTag(id: string, action: 'move_uncategorized' | 'delete_sessions'): string[] {
    if (action === 'delete_sessions') {
      const deletedIds = this.memory.deleteSessionsByTag(id);
      for (const sid of deletedIds) {
        const s = this.sessions.get(sid);
        if (s) {
          if (s.ptyProcess) {
            s.ptyProcess.kill('SIGTERM');
            s.ptyProcess = null;
          }
          s.clients.forEach(ws => ws.close());
          s.clients.clear();
          this.sessions.delete(sid);
        }
      }
      this.memory.deleteTag(id);
      return deletedIds;
    } else {
      this.memory.moveSessionsToTag(id, UNCATEGORIZED_TAG_ID);
      for (const s of this.sessions.values()) {
        if (s.tagId === id) {
          s.tagId = UNCATEGORIZED_TAG_ID;
        }
      }
      this.memory.deleteTag(id);
      return [];
    }
  }

  // --- Session methods ---

  createSession(name: string, cwd: string, tagId: string): Session {
    const record = this.memory.createSession({ name, cwd, status: 'running', tag_id: tagId });
    const session: Session = {
      id: record.id,
      name: record.name,
      cwd: record.cwd,
      status: record.status,
      createdAt: record.created_at,
      lastActiveAt: record.last_active_at,
      ptyProcess: null,
      clients: new Set(),
      claudeSessionId: record.claude_session_id,
      tagId: record.tag_id,
      outputBuffer: [],
      outputBufferStartIndex: 0,
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

  moveSession(id: string, tagId: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.tagId = tagId;
    this.memory.updateSession(id, { tag_id: tagId });
  }

  updateStatus(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.status = status;
    this.memory.updateSession(id, { status });
  }

  saveClaudeSessionId(id: string, claudeSessionId: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.claudeSessionId = claudeSessionId;
    this.memory.updateSession(id, { claude_session_id: claudeSessionId });
    console.log(`[CSM Manager] Saved claudeSessionId=${claudeSessionId} for session ${id}`);
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
      this.onStatusChange?.(id, 'disconnected');
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
    this.sessions.delete(id);
    this.memory.deleteSession(id);
  }

  shutdown(): void {
    for (const s of this.sessions.values()) {
      if (s.ptyProcess) {
        s.ptyProcess.kill('SIGKILL');
        s.ptyProcess = null;
      }
      s.clients.forEach(ws => ws.close());
      s.clients.clear();
      if (s.status === 'running') {
        s.status = 'disconnected';
        this.memory.updateSession(s.id, { status: 'disconnected' });
      }
    }
  }

  touch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const now = Date.now();
    s.lastActiveAt = now;
    this.memory.updateSession(id, { last_active_at: now });
  }

  restoreSessions(): void {
    const records = this.memory.loadAllSessions();
    for (const r of records) {
      this.sessions.set(r.id, {
        id: r.id,
        name: r.name,
        cwd: r.cwd,
        status: r.status,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        ptyProcess: null,
        clients: new Set(),
        claudeSessionId: r.claude_session_id,
        tagId: r.tag_id,
        outputBuffer: [],
        outputBufferStartIndex: 0,
      });
    }
  }

  // --- Path completion ---

  listDirectories(partial: string): string[] {
    return this.memory.listDirectories(partial);
  }
}
