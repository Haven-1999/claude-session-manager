import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryService } from '../../src/server/memory/service';
import * as fs from 'fs';

const TEST_DB = '/tmp/csm-test.db';

describe('MemoryService', () => {
  let service: MemoryService;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    service = new MemoryService(TEST_DB);
  });

  afterEach(() => {
    service.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('creates and retrieves a session', () => {
    const session = service.createSession({ name: 'test', cwd: '/home/user/proj', status: 'running' });
    expect(session.id).toBeDefined();
    expect(session.name).toBe('test');

    const found = service.getSession(session.id);
    expect(found).not.toBeNull();
    expect(found!.cwd).toBe('/home/user/proj');
  });

  it('lists sessions', () => {
    service.createSession({ name: 'a', cwd: '/a', status: 'running' });
    service.createSession({ name: 'b', cwd: '/b', status: 'disconnected' });
    const list = service.listSessions();
    expect(list).toHaveLength(2);
  });

  it('updates session name', () => {
    const s = service.createSession({ name: 'old', cwd: '/x', status: 'running' });
    service.updateSession(s.id, { name: 'new' });
    const found = service.getSession(s.id);
    expect(found!.name).toBe('new');
  });

  it('deletes a session', () => {
    const s = service.createSession({ name: 'del', cwd: '/y', status: 'stopped' });
    service.deleteSession(s.id);
    expect(service.getSession(s.id)).toBeNull();
  });

  it('returns cwd suggestions', () => {
    service.createSession({ name: 'a', cwd: '/projects/one', status: 'running' });
    service.createSession({ name: 'b', cwd: '/projects/one', status: 'running' });
    service.createSession({ name: 'c', cwd: '/projects/two', status: 'running' });
    const suggestions = service.getCwdSuggestions();
    expect(suggestions).toContain('/projects/one');
    expect(suggestions).toContain('/projects/two');
    expect(suggestions.length).toBeLessThanOrEqual(10);
  });
});
