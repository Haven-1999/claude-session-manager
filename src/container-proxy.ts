#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerProxyManager } from './server/container-proxy/manager';
import type { PortRange } from './server/container-proxy/types';

interface CliOptions {
  command: string;
  containerName?: string;
  host: string;
  dataDir: string;
  targetPort: number;
  portRange: PortRange;
}

function parseRange(value: string): PortRange {
  const [startRaw, endRaw] = value.split('-');
  const start = Number.parseInt(startRaw, 10);
  const end = Number.parseInt(endRaw, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
    throw new Error(`Invalid port range: ${value}`);
  }
  return { start, end };
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parsePort(value: string, flag: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port for ${flag}: ${value}`);
  }
  return port;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  let containerName: string | undefined;
  let host = '0.0.0.0';
  let dataDir = path.join(os.homedir(), '.csm');
  let targetPort = 9090;
  let portRange = { start: 9100, end: 9199 };

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--container' || arg === '-c') containerName = readValue(args, i++, arg);
    else if (arg === '--host') host = readValue(args, i++, arg);
    else if (arg === '--data-dir') dataDir = readValue(args, i++, arg);
    else if (arg === '--target-port') targetPort = parsePort(readValue(args, i++, arg), arg);
    else if (arg === '--port-range') portRange = parseRange(readValue(args, i++, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }

  return { command, containerName, host, dataDir, targetPort, portRange };
}

function printHelp(): void {
  console.log(`Usage:
  csm-proxy expose --container <name> [--port-range 9100-9199] [--host 0.0.0.0]
  csm-proxy list [--data-dir ~/.csm]

Examples:
  csm-proxy expose --container csm-alice
  csm-proxy expose --container csm-bob --port-range 9200-9299
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (!fs.existsSync(options.dataDir)) {
    fs.mkdirSync(options.dataDir, { recursive: true });
  }

  const manager = new ContainerProxyManager();

  if (options.command === 'expose') {
    const result = await manager.expose({
      containerName: options.containerName,
      host: options.host,
      targetPort: options.targetPort,
      portRange: options.portRange,
      dataDir: options.dataDir,
    });

    console.log(`Container: ${result.containerName}`);
    console.log(`Target: ${result.containerIp}:${result.targetPort}`);
    console.log(`Host port: ${result.hostPort}`);
    console.log(`Open: ${result.url}`);
    console.log('Proxy process is running in the foreground. Stop it with Ctrl-C, or run it under systemd/tmux if it should stay alive after logout.');
    return;
  }

  if (options.command === 'list') {
    for (const record of manager.list(options.dataDir)) {
      console.log(`${record.containerName}\t${record.status}\t${record.hostPort}\t${record.url}`);
    }
    return;
  }

  printHelp();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
