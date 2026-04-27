import express from 'express';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import type { SessionManager } from './session/manager';
import { setupWebSocketRouter } from './ws/router';

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  claudePath: string;
  auth?: string;
}

export function createHttpServer(manager: SessionManager, options: Pick<ServerOptions, 'claudePath' | 'auth'>): http.Server {
  const app = express();
  app.use(express.json());

  // Optional basic auth
  if (options.auth) {
    const [expectedUser, expectedPass] = options.auth.split(':');
    app.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Unauthorized');
      }
      const creds = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      if (creds !== `${expectedUser}:${expectedPass}`) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Unauthorized');
      }
      next();
    });
  }

  // REST API
  app.get('/api/sessions', (_req, res) => {
    res.json(manager.listSessions().map(s => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    })));
  });

  app.post('/api/sessions', (req, res) => {
    const { name, cwd } = req.body;
    if (!cwd || typeof cwd !== 'string') {
      return res.status(400).json({ error: 'cwd is required' });
    }
    // Validate cwd is absolute and exists
    if (!path.isAbsolute(cwd)) {
      return res.status(400).json({ error: 'cwd must be absolute path' });
    }
    const session = manager.createSession(name || `session-${Date.now()}`, cwd);
    res.status(201).json({
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    });
  });

  app.patch('/api/sessions/:id', (req, res) => {
    const { name } = req.body;
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    if (name) manager.renameSession(req.params.id, name);
    res.json({ id: session.id, name: session.name });
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const session = manager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    manager.closeSession(req.params.id);
    res.status(204).send();
  });

  app.get('/api/cwd-suggestions', (_req, res) => {
    // TODO: implement via MemoryService if needed; stub for now
    res.json([]);
  });

  // Static files
  const publicPath = path.join(__dirname, '../../public');
  app.use(express.static(publicPath));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocketRouter(wss, manager, options.claudePath);

  return server;
}
