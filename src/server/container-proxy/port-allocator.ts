import { createServer } from 'net';
import type { PortRange } from './types';

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(range: PortRange, host: string): Promise<number> {
  for (let port = range.start; port <= range.end; port += 1) {
    if (await canBind(port, host)) return port;
  }

  throw new Error(`No available host port in range ${range.start}-${range.end}`);
}
