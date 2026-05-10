import { randomUUID } from 'crypto';
import { DockerClient } from './docker';
import { findAvailablePort } from './port-allocator';
import { ProxyRegistry } from './registry';
import { startContainerProxy } from './proxy-server';
import type { ExposeOptions, ProxyRecord } from './types';

function browserUrl(host: string, port: number): string {
  const browserHost = host === '0.0.0.0' ? 'SERVER_IP' : host;
  return `http://${browserHost}:${port}`;
}

export class ContainerProxyManager {
  constructor(
    private docker: Pick<DockerClient, 'inspectContainer'> = new DockerClient(),
  ) {}

  async expose(options: ExposeOptions): Promise<ProxyRecord> {
    if (!options.containerName) {
      throw new Error('Missing required --container for expose');
    }

    const container = await this.docker.inspectContainer(options.containerName);
    if (container.state !== 'running') {
      throw new Error(`Docker container is not running: ${options.containerName} (${container.state})`);
    }

    const registry = new ProxyRegistry(options.dataDir);
    const hostPort = await findAvailablePort(options.portRange, options.host);

    await startContainerProxy({
      host: options.host,
      hostPort,
      targetHost: container.ipAddress,
      targetPort: options.targetPort,
    });

    const record: ProxyRecord = {
      id: randomUUID(),
      containerId: container.id,
      containerName: container.name,
      containerIp: container.ipAddress,
      host: options.host,
      hostPort,
      targetPort: options.targetPort,
      url: browserUrl(options.host, hostPort),
      createdAt: Date.now(),
      status: 'running',
    };

    registry.save(record);
    return record;
  }

  list(dataDir: string): ProxyRecord[] {
    return new ProxyRegistry(dataDir).list();
  }
}
