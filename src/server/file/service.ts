import * as fs from 'fs';
import * as path from 'path';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

function normalize(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  // Prevent path traversal: resolved must still be absolute
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid path');
  }
  return resolved;
}

function isBinary(buf: Buffer): boolean {
  // Heuristic: if there are null bytes in the first 8KB, treat as binary
  const sample = buf.slice(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export class FileService {
  readFile(absolutePath: string): { content: string; exists: boolean; isBinary?: boolean; tooLarge?: boolean } {
    const resolved = normalize(absolutePath);
    try {
      const stats = fs.statSync(resolved);
      if (stats.size > MAX_FILE_SIZE) {
        return { content: '', exists: true, tooLarge: true };
      }
      const buf = fs.readFileSync(resolved);
      if (isBinary(buf)) {
        return { content: '', exists: true, isBinary: true };
      }
      return { content: buf.toString('utf-8'), exists: true };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { content: '', exists: false };
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new Error(`Permission denied: ${resolved}`);
      }
      throw err;
    }
  }

  writeFile(absolutePath: string, content: string): void {
    const resolved = normalize(absolutePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      fs.writeFileSync(resolved, content, 'utf-8');
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new Error(`Permission denied: ${resolved}`);
      }
      throw err;
    }
  }
}
