#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHttpServer } from './server/http-server';
import { SessionManager } from './server/session/manager';
import { MemoryService } from './server/memory/service';

function parseArgs(): { port: number; host: string; dataDir: string; claudePath: string; auth?: string } {
  const args = process.argv.slice(2);
  let port = 8080;
  let host = '127.0.0.1';
  let dataDir = path.join(os.homedir(), '.csm');
  let claudePath = 'claude';
  let auth: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10);
    else if (args[i] === '--host' || args[i] === '-h') host = args[++i];
    else if (args[i] === '--data-dir') dataDir = args[++i];
    else if (args[i] === '--claude-path') claudePath = args[++i];
    else if (args[i] === '--auth') auth = args[++i];
  }

  return { port, host, dataDir, claudePath, auth };
}

function main(): void {
  const opts = parseArgs();

  if (!fs.existsSync(opts.dataDir)) {
    fs.mkdirSync(opts.dataDir, { recursive: true });
  }

  const dbPath = path.join(opts.dataDir, 'sessions.db');
  const memory = new MemoryService(dbPath);
  const manager = new SessionManager(memory);
  manager.restoreSessions();

  const { server, wss } = createHttpServer(manager, { claudePath: opts.claudePath, auth: opts.auth, dataDir: opts.dataDir });

  server.listen(opts.port, opts.host, () => {
    console.log(`CSM listening on http://${opts.host}:${opts.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    wss.close(() => {
      server.close(() => {
        manager.shutdown();
        memory.close();
        process.exit(0);
      });
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
