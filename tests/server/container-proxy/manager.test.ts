import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainerProxyManager } from '../../../src/server/container-proxy/manager';
import type { ContainerInfo } from '../../../src/server/container-proxy/types';

class FakeDockerClient {
  constructor(private container: ContainerInfo) {}

  async inspectContainer(): Promise<ContainerInfo> {
    return this.container;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csm-proxy-manager-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ContainerProxyManager', () => {
  it('requires a container name for expose', async () => {
    const manager = new ContainerProxyManager(new FakeDockerClient({
      id: 'unused',
      name: 'unused',
      state: 'running',
      ipAddress: '127.0.0.1',
    }));

    await expect(manager.expose({
      host: '127.0.0.1',
      targetPort: 9090,
      portRange: { start: 19300, end: 19302 },
      dataDir: dir,
    })).rejects.toThrow('Missing required --container for expose');
  });

  it('rejects containers that are not running', async () => {
    const manager = new ContainerProxyManager(new FakeDockerClient({
      id: 'abc123',
      name: 'csm-alice',
      state: 'exited',
      ipAddress: '127.0.0.1',
    }));

    await expect(manager.expose({
      containerName: 'csm-alice',
      host: '127.0.0.1',
      targetPort: 9090,
      portRange: { start: 19310, end: 19312 },
      dataDir: dir,
    })).rejects.toThrow('Docker container is not running: csm-alice (exited)');
  });
});
