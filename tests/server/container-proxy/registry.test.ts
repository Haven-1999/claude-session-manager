import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProxyRegistry } from '../../../src/server/container-proxy/registry';
import type { ProxyRecord } from '../../../src/server/container-proxy/types';

let dir: string;

const record: ProxyRecord = {
  id: 'proxy-1',
  containerId: 'abc123',
  containerName: 'csm-alice',
  containerIp: '172.17.0.2',
  host: '0.0.0.0',
  hostPort: 9137,
  targetPort: 9090,
  url: 'http://127.0.0.1:9137',
  createdAt: 1778299991000,
  status: 'running',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csm-proxy-registry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ProxyRegistry', () => {
  it('starts empty when the registry file does not exist', () => {
    const registry = new ProxyRegistry(dir);
    expect(registry.list()).toEqual([]);
  });

  it('persists records across registry instances', () => {
    const registry = new ProxyRegistry(dir);
    registry.save(record);

    const reloaded = new ProxyRegistry(dir);
    expect(reloaded.list()).toEqual([record]);
  });

  it('replaces an existing record for the same container name', () => {
    const registry = new ProxyRegistry(dir);
    registry.save(record);
    registry.save({ ...record, id: 'proxy-2', hostPort: 9138 });

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].hostPort).toBe(9138);
  });

  it('marks a record stopped', () => {
    const registry = new ProxyRegistry(dir);
    registry.save(record);
    registry.markStopped('proxy-1');

    expect(registry.list()[0].status).toBe('stopped');
  });
});
