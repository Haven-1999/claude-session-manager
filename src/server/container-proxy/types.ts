export interface ContainerInfo {
  id: string;
  name: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | string;
  ipAddress: string;
}

export interface PortRange {
  start: number;
  end: number;
}

export interface ExposeOptions {
  containerName?: string;
  host: string;
  targetPort: number;
  portRange: PortRange;
  dataDir: string;
}

export interface ProxyRecord {
  id: string;
  containerId: string;
  containerName: string;
  containerIp: string;
  host: string;
  hostPort: number;
  targetPort: number;
  url: string;
  createdAt: number;
  status: 'running' | 'stopped';
}

export interface ProxyRegistryData {
  proxies: ProxyRecord[];
}
