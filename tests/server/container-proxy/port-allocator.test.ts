import { createServer } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { findAvailablePort } from '../../../src/server/container-proxy/port-allocator';

const servers: ReturnType<typeof createServer>[] = [];

function listen(port: number): Promise<void> {
  const server = createServer();
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('findAvailablePort', () => {
  it('returns the first bindable port in the range', async () => {
    const port = await findAvailablePort({ start: 19100, end: 19102 }, '127.0.0.1');
    expect(port).toBe(19100);
  });

  it('skips occupied ports', async () => {
    await listen(19110);
    const port = await findAvailablePort({ start: 19110, end: 19112 }, '127.0.0.1');
    expect(port).toBe(19111);
  });

  it('throws when the range is full', async () => {
    await listen(19120);
    await listen(19121);
    await expect(findAvailablePort({ start: 19120, end: 19121 }, '127.0.0.1')).rejects.toThrow('No available host port in range 19120-19121');
  });
});
