import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/server/session/manager';
import { MemoryService } from '../../src/server/memory/service';
import * as fs from 'fs';

const TEST_DB = '/tmp/csm-manager-test.db';

describe('SessionManager', () => {
  let memory: MemoryService;
  let manager: SessionManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    memory = new MemoryService(TEST_DB);
    manager = new SessionManager(memory);
  });

  it('creates a session', () => {
    const s = manager.createSession('proj1', '/home/user/proj1');
    expect(s.name).toBe('proj1');
    expect(s.cwd).toBe('/home/user/proj1');
    expect(s.status).toBe('running');
    expect(s.clients.size).toBe(0);
  });

  it('lists sessions', () => {
    manager.createSession('a', '/a');
    manager.createSession('b', '/b');
    expect(manager.listSessions()).toHaveLength(2);
  });

  it('renames a session', () => {
    const s = manager.createSession('old', '/x');
    manager.renameSession(s.id, 'new');
    expect(manager.getSession(s.id)!.name).toBe('new');
  });

  it('marks stopped on close without PTY', () => {
    const s = manager.createSession('temp', '/tmp');
    manager.closeSession(s.id);
    expect(manager.getSession(s.id)!.status).toBe('stopped');
  });
});
