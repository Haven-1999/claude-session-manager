import * as fs from 'fs';
import * as path from 'path';
import type { ProxyRecord, ProxyRegistryData } from './types';

export class ProxyRegistry {
  private filePath: string;

  constructor(private dataDir: string) {
    this.filePath = path.join(dataDir, 'container-proxies.json');
  }

  list(): ProxyRecord[] {
    return this.read().proxies;
  }

  save(record: ProxyRecord): void {
    const data = this.read();
    data.proxies = data.proxies.filter(proxy => proxy.containerName !== record.containerName && proxy.id !== record.id);
    data.proxies.push(record);
    this.write(data);
  }

  markStopped(id: string): void {
    const data = this.read();
    data.proxies = data.proxies.map(proxy => proxy.id === id ? { ...proxy, status: 'stopped' } : proxy);
    this.write(data);
  }

  private read(): ProxyRegistryData {
    if (!fs.existsSync(this.filePath)) return { proxies: [] };
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ProxyRegistryData;
  }

  private write(data: ProxyRegistryData): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
