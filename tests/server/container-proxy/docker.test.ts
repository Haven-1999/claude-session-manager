import { describe, expect, it } from 'vitest';
import { DockerClient } from '../../../src/server/container-proxy/docker';

const runningInspect = JSON.stringify([
  {
    Id: 'abc123',
    Name: '/csm-alice',
    State: { Status: 'running' },
    NetworkSettings: {
      IPAddress: '',
      Networks: {
        bridge: { IPAddress: '172.17.0.2' },
      },
    },
  },
]);

describe('DockerClient', () => {
  it('resolves a running container by name', async () => {
    const client = new DockerClient(async (cmd, args) => {
      expect(cmd).toBe('docker');
      expect(args).toEqual(['inspect', 'csm-alice']);
      return runningInspect;
    });

    await expect(client.inspectContainer('csm-alice')).resolves.toEqual({
      id: 'abc123',
      name: 'csm-alice',
      state: 'running',
      ipAddress: '172.17.0.2',
    });
  });

  it('rejects a missing container', async () => {
    const client = new DockerClient(async () => {
      throw new Error('No such object: csm-missing');
    });

    await expect(client.inspectContainer('csm-missing')).rejects.toThrow('Docker container not found: csm-missing');
  });

  it('preserves Docker command failures that are not missing-container errors', async () => {
    const client = new DockerClient(async () => {
      throw new Error('permission denied while trying to connect to the Docker daemon socket');
    });

    await expect(client.inspectContainer('csm-alice')).rejects.toThrow('Docker command failed: permission denied while trying to connect to the Docker daemon socket');
  });

  it('rejects malformed docker inspect output', async () => {
    const client = new DockerClient(async () => 'not-json');

    await expect(client.inspectContainer('csm-alice')).rejects.toThrow('Docker returned invalid inspect output for: csm-alice');
  });

  it('rejects a container without an IP address', async () => {
    const client = new DockerClient(async () => JSON.stringify([
      {
        Id: 'abc123',
        Name: '/csm-no-ip',
        State: { Status: 'running' },
        NetworkSettings: { IPAddress: '', Networks: {} },
      },
    ]));

    await expect(client.inspectContainer('csm-no-ip')).rejects.toThrow('Docker container has no reachable IP address: csm-no-ip');
  });
});
