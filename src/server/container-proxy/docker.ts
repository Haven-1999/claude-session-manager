import { execFile } from 'child_process';
import type { ContainerInfo } from './types';

type CommandRunner = (command: string, args: string[]) => Promise<string>;

interface DockerInspectRow {
  Id?: string;
  Name?: string;
  State?: { Status?: string };
  NetworkSettings?: {
    IPAddress?: string;
    Networks?: Record<string, { IPAddress?: string }>;
  };
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function firstContainerIp(row: DockerInspectRow): string {
  if (row.NetworkSettings?.IPAddress) return row.NetworkSettings.IPAddress;

  const networks = row.NetworkSettings?.Networks ?? {};
  for (const network of Object.values(networks)) {
    if (network.IPAddress) return network.IPAddress;
  }

  return '';
}

export class DockerClient {
  constructor(private runner: CommandRunner = runCommand) {}

  async inspectContainer(containerName: string): Promise<ContainerInfo> {
    let output: string;
    try {
      output = await this.runner('docker', ['inspect', containerName]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No such object') || message.includes('not found')) {
        throw new Error(`Docker container not found: ${containerName}`);
      }
      throw new Error(`Docker command failed: ${message}`);
    }

    let rows: DockerInspectRow[];
    try {
      rows = JSON.parse(output) as DockerInspectRow[];
    } catch {
      throw new Error(`Docker returned invalid inspect output for: ${containerName}`);
    }

    const row = rows[0];
    if (!row?.Id) {
      throw new Error(`Docker container not found: ${containerName}`);
    }

    const ipAddress = firstContainerIp(row);
    if (!ipAddress) {
      throw new Error(`Docker container has no reachable IP address: ${containerName}`);
    }

    return {
      id: row.Id,
      name: (row.Name ?? containerName).replace(/^\//, ''),
      state: row.State?.Status ?? 'unknown',
      ipAddress,
    };
  }
}
