import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import { setupShellWebSocketRouter } from '../../src/server/ws/shell-router';
import { SessionManager } from '../../src/server/session/manager';
import { MemoryService } from '../../src/server/memory/service';
import * as fs from 'fs';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
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

class MockPty {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataHandler: ((data: string) => void) | null = null;
  private exitHandler: (() => void) | null = null;

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
  }

  onExit(handler: () => void) {
    this.exitHandler = handler;
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
    this.exitHandler?.();
  }

  emitData(data: string) {
    this.dataHandler?.(data);
  }
}

const TEST_DB = '/tmp/csm-shell-router-test.db';

function connect(wss: MockWss, url: string) {
  const ws = new MockWs();
  wss.emit('connection', ws, { url, headers: { host: 'localhost' } });
  return ws;
}

describe('setupShellWebSocketRouter', () => {
  let manager: SessionManager;
  let wss: MockWss;
  let ptyProcess: MockPty;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    manager = new SessionManager(new MemoryService(TEST_DB));
    wss = new MockWss();
    ptyProcess = new MockPty();
    const nodePty = await import('node-pty');
    vi.mocked(nodePty.spawn).mockReturnValue(ptyProcess as any);
  });

  it('rejects connections without a session id', () => {
    setupShellWebSocketRouter(wss as unknown as WebSocketServer, manager);

    const ws = connect(wss, '/shell-ws');

    expect(ws.closed).toEqual({ code: 1008, reason: 'Missing sessionId' });
  });

  it('rejects connections for unknown sessions', () => {
    setupShellWebSocketRouter(wss as unknown as WebSocketServer, manager);

    const ws = connect(wss, '/shell-ws?sessionId=missing');

    expect(ws.closed).toEqual({ code: 1008, reason: 'Session not found' });
  });

  it('spawns the default shell in the session cwd', async () => {
    const session = manager.createSession('project', '/tmp');
    setupShellWebSocketRouter(wss as unknown as WebSocketServer, manager);

    connect(wss, `/shell-ws?sessionId=${session.id}`);

    const nodePty = await import('node-pty');
    expect(nodePty.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: '/tmp', cols: 120, rows: 30, name: 'xterm-256color' }),
    );
  });

  it('forwards shell output, input, and resize messages', () => {
    const session = manager.createSession('project', '/tmp');
    setupShellWebSocketRouter(wss as unknown as WebSocketServer, manager);
    const ws = connect(wss, `/shell-ws?sessionId=${session.id}`);

    ptyProcess.emitData('hello');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'pwd\\r' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 80, rows: 12 })));

    expect(ws.sent).toContain(JSON.stringify({ type: 'output', data: 'hello' }));
    expect(ptyProcess.writes).toEqual(['pwd\\r']);
    expect(ptyProcess.resizes).toEqual([{ cols: 80, rows: 12 }]);
  });

  it('kills the shell process when the WebSocket closes', () => {
    const session = manager.createSession('project', '/tmp');
    setupShellWebSocketRouter(wss as unknown as WebSocketServer, manager);
    const ws = connect(wss, `/shell-ws?sessionId=${session.id}`);

    ws.emit('close');

    expect(ptyProcess.killed).toBe(true);
  });
});
