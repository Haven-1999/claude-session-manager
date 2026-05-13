import * as http from 'http';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../../src/server/http-server';

vi.mock('../../src/server/session/pty', () => ({
  spawnPty: vi.fn(() => ({
    pid: 1234,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
  broadcastToSession: vi.fn(),
  broadcastStatus: vi.fn(),
  waitForClaudeSessionId: vi.fn(() => Promise.resolve(null)),
}));

class TestManager {
  onStatusChange?: (id: string, status: 'running' | 'disconnected' | 'stopped') => void;
  session = {
    id: 'session-1',
    name: 'session-1',
    cwd: '/tmp',
    status: 'running' as const,
    ptyProcess: null as any,
    clients: new Set<WebSocket>(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    claudeSessionId: null,
    outputBuffer: ['hello'],
    outputBufferStartIndex: 0,
  };

  listSessions() {
    return [this.session];
  }

  getSession(id: string) {
    return id === this.session.id ? this.session : undefined;
  }

  createSession() {
    return this.session;
  }

  renameSession() {}
  closeSession() {}
  touch() {}
  updateStatus() {}
  saveClaudeSessionId() {}

  attachClient(_id: string, ws: WebSocket) {
    this.session.clients.add(ws);
  }

  detachClient(_id: string, ws: WebSocket) {
    this.session.clients.delete(ws);
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('createHttpServer WebSocket routing', () => {
  it('keeps /ws connections open when /shell-ws is also registered', async () => {
    const manager = new TestManager();
    const { server } = createHttpServer(manager as any, {
      claudePath: 'claude',
      dataDir: '/tmp',
      auth: undefined,
    });
    const port = await listen(server);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=session-1&replayFrom=0`);
      const firstMessage = await new Promise<string>((resolve, reject) => {
        ws.on('message', data => resolve(data.toString()));
        ws.on('error', reject);
      });

      expect(JSON.parse(firstMessage)).toEqual({ type: 'status', status: 'running' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    } finally {
      await close(server);
    }
  });
});
