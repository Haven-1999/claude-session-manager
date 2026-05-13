import express from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { WebSocketServer } from 'ws';
import type { SessionManager } from './session/manager';
import { setupWebSocketRouter } from './ws/router';
import { setupShellWebSocketRouter } from './ws/shell-router';
import { FileService } from './file/service';

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  claudePath: string;
  auth?: string;
}

export function createHttpServer(manager: SessionManager, options: Pick<ServerOptions, 'claudePath' | 'auth' | 'dataDir'>): { server: http.Server; wss: WebSocketServer } {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

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
      claudeSessionId: s.claudeSessionId,
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

  app.post('/api/upload', (req, res) => {
    const { sessionId, filename, data } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename is required' });
    }
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'data is required' });
    }

    const uploadDir = path.join(options.dataDir, 'uploads', sessionId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(uploadDir, `${Date.now()}_${safeName}`);

    try {
      const buffer = Buffer.from(data, 'base64');
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
      if (buffer.length > MAX_IMAGE_SIZE) {
        return res.status(413).json({ error: 'File too large (max 10MB)' });
      }
      fs.writeFileSync(filePath, buffer);
      res.json({ path: filePath });
    } catch (err: any) {
      console.error('[CSM UPLOAD] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const fileService = new FileService();

  app.get('/api/files', (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path query parameter is required' });
    }
    try {
      const result = fileService.readFile(filePath);
      if (!result.exists) {
        return res.status(404).json({ error: 'File not found' });
      }
      if (result.tooLarge) {
        return res.status(413).json({ error: 'File too large (max 1MB)' });
      }
      if (result.isBinary) {
        return res.status(415).json({ error: 'Binary files cannot be edited' });
      }
      res.json({ content: result.content, path: filePath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/files', (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }
    try {
      fileService.writeFile(filePath, content);
      res.json({ saved: true, path: filePath });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Static files
  const publicPath = path.join(__dirname, '../../public');
  app.use(express.static(publicPath));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const shellWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url || '/', `http://${req.headers.host}`);
    const target = pathname === '/ws' ? wss : pathname === '/shell-ws' ? shellWss : null;

    if (!target) {
      socket.destroy();
      return;
    }

    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit('connection', ws, req);
    });
  });

  setupWebSocketRouter(wss, manager, options.claudePath);
  setupShellWebSocketRouter(shellWss, manager);

  return { server, wss };
}
