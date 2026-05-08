import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { SessionManager } from '../session/manager';
import type { Session } from '../session/types';
import { spawnPty, broadcastToSession, broadcastStatus, waitForClaudeSessionId } from '../session/pty';

interface WsMessage {
  type: 'input' | 'resize' | 'ping';
  data?: string;
  cols?: number;
  rows?: number;
}

export function setupWebSocketRouter(wss: WebSocketServer, manager: SessionManager, claudePath: string): void {
  manager.onStatusChange = (id, status) => {
    const session = manager.getSession(id);
    if (session) broadcastStatus(session);
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    console.log(`[CSM WS] New connection, sessionId=${sessionId}, url=${req.url}`);
    if (!sessionId) {
      console.log('[CSM WS] Reject: missing sessionId');
      ws.close(1008, 'Missing sessionId');
      return;
    }

    let session = manager.getSession(sessionId);
    if (!session) {
      console.log(`[CSM WS] Reject: session ${sessionId} not found`);
      ws.close(1008, 'Session not found');
      return;
    }

    let pendingInput: string[] = [];
    let pendingResize: { cols: number; rows: number } | null = null;
    let isSpawning = false;

    const ensurePty = (): boolean => {
      if (session!.ptyProcess) {
        console.log(`[CSM WS] ensurePty: already running for ${session!.id}`);
        return true;
      }
      if (isSpawning) {
        console.log(`[CSM WS] ensurePty: spawn already in progress for ${session!.id}`);
        return true;
      }

      if (session!.status === 'stopped') {
        console.log(`[CSM WS] ensurePty: session ${session!.id} is stopped, allowing resume`);
        session!.status = 'disconnected';
        manager.updateStatus(session!.id, 'disconnected');
      }

      isSpawning = true;

      const cols = pendingResize?.cols ?? 120;
      const rows = pendingResize?.rows ?? 30;
      const resumeClaudeId = session!.claudeSessionId;

      try {
        console.log(`[CSM WS] Spawning PTY for session ${session!.id} in ${session!.cwd} (${cols}x${rows}) resume=${!!resumeClaudeId}`);
        const pty = spawnPty({
          cwd: session!.cwd,
          sessionId: session!.id,
          claudePath,
          cols,
          rows,
          resumeClaudeId,
        });
        session!.ptyProcess = pty;
        const pid = (pty as any).pid as number;
        console.log(`[CSM WS] PTY spawned, PID: ${pid}`);
        const spawnTime = Date.now();

        // Capture Claude's session ID asynchronously
        if (!session!.claudeSessionId) {
          waitForClaudeSessionId(pid, 10000).then((claudeId) => {
            if (claudeId) {
              manager.saveClaudeSessionId(session!.id, claudeId);
            }
          });
        }

        isSpawning = false;
        pty.onData((data) => {
          manager.touch(session!.id);
          broadcastToSession(session!, data);
        });
        pty.onExit(({ exitCode }) => {
          const elapsed = Date.now() - spawnTime;
          console.log(`[CSM WS] PTY exited for session ${session!.id}, code: ${exitCode}, elapsed=${elapsed}ms`);
          session!.ptyProcess = null;

          // If PTY exited quickly with resume, the claudeSessionId is stale
          if (resumeClaudeId && elapsed < 3000) {
            console.log(`[CSM WS] PTY exited quickly with resume — clearing stale claudeSessionId and retrying fresh`);
            session!.claudeSessionId = null;
            manager.saveClaudeSessionId(session!.id, '');
            setTimeout(() => {
              if (!session!.ptyProcess && session!.status !== 'stopped') {
                ensurePty();
              }
            }, 500);
            return;
          }

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
        isSpawning = false;
        ws.close(1011, 'Failed to spawn PTY');
        return false;
      }
    };

    manager.attachClient(sessionId, ws);
    broadcastStatus(session);
    ws.send(JSON.stringify({ type: 'status', status: session.status }));

    // Eagerly spawn PTY if not already running so the user sees output immediately
    if (!session.ptyProcess && session.status !== 'stopped') {
      console.log(`[CSM WS] Eagerly spawning PTY for session ${session.id}`);
      ensurePty();
    }

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
        console.log(`[CSM WS] Message from ${sessionId}: type=${msg.type}`);
        manager.touch(sessionId);
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
