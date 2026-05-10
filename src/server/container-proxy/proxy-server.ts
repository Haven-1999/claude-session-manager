import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';

export interface StartContainerProxyOptions {
  host: string;
  hostPort: number;
  targetHost: string;
  targetPort: number;
}

export interface RunningContainerProxy {
  server: http.Server;
  close: () => Promise<void>;
}

const hopByHopHeaders = new Set([
  'connection',
  'host',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
  'upgrade',
]);

function upstreamHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (hopByHopHeaders.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

export function startContainerProxy(options: StartContainerProxyOptions): Promise<RunningContainerProxy> {
  const server = http.createServer((req, res) => {
    const targetReq = http.request({
      host: options.targetHost,
      port: options.targetPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (targetRes) => {
      res.writeHead(targetRes.statusCode ?? 502, targetRes.headers);
      targetRes.pipe(res);
    });

    targetReq.on('error', (error) => {
      res.statusCode = 502;
      res.end(`Proxy target unavailable: ${error.message}`);
    });

    req.pipe(targetReq);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      const target = new WebSocket(`ws://${options.targetHost}:${options.targetPort}${req.url ?? '/'}`, {
        headers: upstreamHeaders(req.headers),
      });

      const pendingMessages: string[] = [];

      const forwardToTarget = (data: WebSocket.RawData) => {
        const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
        if (target.readyState === WebSocket.OPEN) {
          target.send(text);
          return;
        }
        pendingMessages.push(text);
      };

      client.on('message', forwardToTarget);

      target.once('open', () => {
        for (const text of pendingMessages.splice(0)) {
          target.send(text);
        }
      });

      target.on('message', data => {
        if (client.readyState !== WebSocket.OPEN) return;
        // ws 'message' gives Buffer even for text frames; re-send as string
        // so the browser receives text frames, not binary blobs
        const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
        client.send(text);
      });

      const closeSocket = (ws: WebSocket) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };

      const closeBoth = () => {
        closeSocket(client);
        closeSocket(target);
      };

      const failClient = (message: string) => {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(1011, message);
        }
      };

      target.once('error', error => {
        failClient(`Proxy target unavailable: ${(error as Error).message}`);
        closeBoth();
      });

      client.on('close', closeBoth);
      client.on('error', closeBoth);
      target.on('close', closeBoth);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.hostPort, options.host, () => {
      server.off('error', reject);
      resolve({
        server,
        close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}
