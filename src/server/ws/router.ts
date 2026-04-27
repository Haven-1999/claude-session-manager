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

    // Spawn PTY if not running
    if (!session.ptyProcess && session.status !== 'stopped') {
      try {
        const pty = spawnPty({
          cwd: session.cwd,
          sessionId: session.id,
          claudePath,
        });
        session.ptyProcess = pty;
        pty.onData((data) => {
          broadcastToSession(session!, data);
        });
        pty.onExit(({ exitCode }) => {
          session!.ptyProcess = null;
          manager.updateStatus(session!.id, 'stopped');
          broadcastStatus(session!);
        });
      } catch (err) {
        ws.close(1011, 'Failed to spawn PTY');
        return;
      }
    }

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
        if (msg.type === 'input' && msg.data && session!.ptyProcess) {
          session!.ptyProcess.write(msg.data);
        } else if (msg.type === 'resize' && session!.ptyProcess) {
          session!.ptyProcess.resize(msg.cols || 120, msg.rows || 30);
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
