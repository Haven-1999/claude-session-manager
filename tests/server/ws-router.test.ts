import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import { setupWebSocketRouter } from '../../src/server/ws/router';

vi.mock('../../src/server/session/pty', () => ({
  spawnPty: vi.fn(() => {
    throw new Error('spawn ENOENT');
  }),
  broadcastToSession: vi.fn(),
  broadcastStatus: vi.fn(),
  waitForClaudeSessionId: vi.fn(() => Promise.resolve(null)),
}));

class MockWs extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;

  send(message: string) {
    this.sent.push(message);
  }

  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
}

class MockWss extends EventEmitter {}

class TestManager {
  onStatusChange?: (id: string, status: 'running' | 'disconnected' | 'stopped') => void;
  session = {
    id: 'session-1',
    name: 'session-1',
    cwd: '/tmp',
    status: 'running' as const,
    ptyProcess: null as any,
    clients: new Set<MockWs>(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    claudeSessionId: null,
    outputBuffer: [],
    outputBufferStartIndex: 0,
  };

  getSession(id: string) {
    return id === this.session.id ? this.session : undefined;
  }

  attachClient(_id: string, ws: MockWs) {
    this.session.clients.add(ws);
  }

  detachClient(_id: string, ws: MockWs) {
    this.session.clients.delete(ws);
  }

  updateStatus(_id: string, status: 'running' | 'disconnected' | 'stopped') {
    this.session.status = status as typeof this.session.status;
  }

  touch() {}
  saveClaudeSessionId() {}
}

function connect(wss: MockWss, url: string) {
  const ws = new MockWs();
  wss.emit('connection', ws, { url, headers: { host: 'localhost' } });
  return ws;
}

describe('setupWebSocketRouter', () => {
  it('marks the session stopped when PTY spawn fails', () => {
    const manager = new TestManager();
    const wss = new MockWss();
    setupWebSocketRouter(wss as unknown as WebSocketServer, manager as any, 'missing-claude');

    const ws = connect(wss, '/ws?sessionId=session-1&replayFrom=0');

    expect(ws.closed).toEqual({ code: 1011, reason: 'Failed to spawn PTY' });
    expect(manager.session.status).toBe('stopped');
  });
});
