import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { startContainerProxy } from '../../../src/server/container-proxy/proxy-server';

const servers: http.Server[] = [];
const sockets: WebSocket[] = [];

function listen(server: http.Server, port: number): Promise<void> {
  servers.push(server);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('startContainerProxy', () => {
  it('forwards HTTP requests to the target CSM service', async () => {
    const target = http.createServer((req, res) => {
      expect(req.url).toBe('/api/sessions');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 'session-1' }]));
    });
    await listen(target, 19210);

    const proxy = await startContainerProxy({
      host: '127.0.0.1',
      hostPort: 19211,
      targetHost: '127.0.0.1',
      targetPort: 19210,
    });
    servers.push(proxy.server);

    const body = await new Promise<string>((resolve, reject) => {
      http.get('http://127.0.0.1:19211/api/sessions', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });

    expect(JSON.parse(body)).toEqual([{ id: 'session-1' }]);
  });

  it('forwards immediate WebSocket messages from the target service', async () => {
    const target = http.createServer();
    const targetWss = new WebSocketServer({ server: target, path: '/ws' });
    targetWss.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'status', status: 'running' }));
    });
    await listen(target, 19230);

    const proxy = await startContainerProxy({
      host: '127.0.0.1',
      hostPort: 19231,
      targetHost: '127.0.0.1',
      targetPort: 19230,
    });
    servers.push(proxy.server);

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:19231/ws?sessionId=session-1&replayFrom=0');
      sockets.push(ws);
      ws.on('message', data => resolve(data.toString()));
      ws.on('error', reject);
    });

    expect(JSON.parse(reply)).toEqual({ type: 'status', status: 'running' });
  });

  it('forwards WebSocket traffic to the target CSM service', async () => {
    const target = http.createServer();
    const targetWss = new WebSocketServer({ server: target, path: '/ws' });
    targetWss.on('connection', ws => {
      ws.on('message', data => ws.send(`target:${data.toString()}`));
    });
    await listen(target, 19220);

    const proxy = await startContainerProxy({
      host: '127.0.0.1',
      hostPort: 19221,
      targetHost: '127.0.0.1',
      targetPort: 19220,
    });
    servers.push(proxy.server);

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:19221/ws');
      sockets.push(ws);
      ws.on('open', () => ws.send('ping'));
      ws.on('message', data => resolve(data.toString()));
      ws.on('error', reject);
    });

    expect(reply).toBe('target:ping');
  });

  it('forwards target text frames as text, not binary blobs', async () => {
    const target = http.createServer();
    const targetWss = new WebSocketServer({ server: target, path: '/ws' });
    targetWss.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'status', status: 'running' }));
    });
    await listen(target, 19240);

    const proxy = await startContainerProxy({
      host: '127.0.0.1',
      hostPort: 19241,
      targetHost: '127.0.0.1',
      targetPort: 19240,
    });
    servers.push(proxy.server);

    const reply = await new Promise<{ isBinary: boolean; payload: string }>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:19241/ws?sessionId=session-1&replayFrom=0');
      sockets.push(ws);
      ws.on('message', (data, isBinary) => {
        resolve({
          isBinary: isBinary ?? true,
          payload: data.toString(),
        });
      });
      ws.on('error', reject);
    });

    expect(reply.isBinary).toBe(false);
    expect(JSON.parse(reply.payload)).toEqual({ type: 'status', status: 'running' });
  });

  it('forwards client text frames as text, not binary blobs', async () => {
    const target = http.createServer();
    const targetWss = new WebSocketServer({ server: target, path: '/ws' });
    targetWss.on('connection', ws => {
      ws.on('message', (_data, isBinary) => {
        ws.send(JSON.stringify({ isBinary: isBinary ?? true, payload: _data.toString() }));
      });
    });
    await listen(target, 19250);

    const proxy = await startContainerProxy({
      host: '127.0.0.1',
      hostPort: 19251,
      targetHost: '127.0.0.1',
      targetPort: 19250,
    });
    servers.push(proxy.server);

    const reply = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:19251/ws');
      sockets.push(ws);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', data => resolve(JSON.parse(data.toString())));
      ws.on('error', reject);
    });

    expect(reply.isBinary).toBe(false);
    expect(reply.payload).toBe('hello');
  });
});
