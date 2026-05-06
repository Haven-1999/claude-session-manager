import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { SessionManager } from '../session/manager';
import type { Session } from '../session/types';
import { spawnPty, broadcastToSession, broadcastStatus } from '../session/pty';

interface WsMessage {
  type: 'input' | 'resize' | 'ping';
  data?: string;
  cols?: number;
  rows?: number;
}

export function setupWebSocketRouter(wss: WebSocketServer, manager: SessionManager, claudePath: string): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      ws.close(1008, 'Missing sessionId');
      return;
    }

    let session = manager.getSession(sessionId);
    if (!session) {
      ws.close(1008, 'Session not found');
      return;
    }

    let pendingInput: string[] = [];
    let pendingResize: { cols: number; rows: number } | null = null;

    const ensurePty = (): boolean => {
      if (session!.ptyProcess) return true;
      if (session!.status === 'stopped') return false;

      const cols = pendingResize?.cols ?? 120;
      const rows = pendingResize?.rows ?? 30;

      try {
        const pty = spawnPty({
          cwd: session!.cwd,
          sessionId: session!.id,
          claudePath,
          cols,
          rows,
        });
        session!.ptyProcess = pty;
        pty.onData((data) => {
          broadcastToSession(session!, data);
        });
        pty.onExit(({ exitCode }) => {
          session!.ptyProcess = null;
          manager.updateStatus(session!.id, 'stopped');
          broadcastStatus(session!);
        });

        // Flush any pending resize
        if (pendingResize) {
          pty.resize(pendingResize.cols, pendingResize.rows);
          pendingResize = null;
        }

        // Flush any pending input
        for (const data of pendingInput) {
          pty.write(data);
        }
        pendingInput = [];

        return true;
      } catch (err) {
        ws.close(1011, 'Failed to spawn PTY');
        return false;
      }
    };

    manager.attachClient(sessionId, ws);
    broadcastStatus(session);
    ws.send(JSON.stringify({ type: 'status', status: session.status }));

    let heartbeatTimer: NodeJS.Timeout;
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        ws.close(1001, 'Heartbeat timeout');
      }, 35000);
    };
    resetHeartbeat();

    ws.on('message', (raw) => {
      resetHeartbeat();
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        if (msg.type === 'input' && msg.data) {
          if (session!.ptyProcess) {
            session!.ptyProcess.write(msg.data);
          } else {
            pendingInput.push(msg.data);
            ensurePty();
          }
        } else if (msg.type === 'resize') {
          const cols = msg.cols ?? 120;
          const rows = msg.rows ?? 30;
          pendingResize = { cols, rows };
          if (session!.ptyProcess) {
            session!.ptyProcess.resize(cols, rows);
          } else {
            ensurePty();
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      clearTimeout(heartbeatTimer);
      manager.detachClient(sessionId, ws);
    });

    ws.on('error', () => {
      clearTimeout(heartbeatTimer);
      manager.detachClient(sessionId, ws);
    });
  });
}
