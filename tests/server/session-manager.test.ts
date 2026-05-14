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
    const s = manager.createSession('proj1', '/home/user/proj1', 'uncategorized');
    expect(s.name).toBe('proj1');
    expect(s.cwd).toBe('/home/user/proj1');
    expect(s.status).toBe('running');
    expect(s.clients.size).toBe(0);
    expect(s.tagId).toBe('uncategorized');
  });

  it('lists sessions', () => {
    manager.createSession('a', '/a', 'uncategorized');
    manager.createSession('b', '/b', 'uncategorized');
    expect(manager.listSessions()).toHaveLength(2);
  });

  it('renames a session', () => {
    const s = manager.createSession('old', '/x', 'uncategorized');
    manager.renameSession(s.id, 'new');
    expect(manager.getSession(s.id)!.name).toBe('new');
  });

  it('keeps session running while any client remains connected', () => {
    const s = manager.createSession('proj', '/home/user/proj', 'uncategorized');
    const firstClient = {} as any;
    const secondClient = {} as any;

    manager.attachClient(s.id, firstClient);
    manager.attachClient(s.id, secondClient);
    manager.detachClient(s.id, firstClient);

    expect(manager.getSession(s.id)!.status).toBe('running');
  });

  it('moves a session to a different tag', () => {
    const tag = memory.createTag('test-tag');
    const s = manager.createSession('sess', '/tmp', 'uncategorized');
    manager.moveSession(s.id, tag.id);
    expect(manager.getSession(s.id)!.tagId).toBe(tag.id);
  });

  it('manages tags via createTag and listTags', () => {
    const tag = manager.createTag('my-tag');
    expect(tag.name).toBe('my-tag');
    const tags = manager.listTags();
    expect(tags.some(t => t.name === 'my-tag')).toBe(true);
    expect(tags.some(t => t.id === 'uncategorized')).toBe(true);
  });

  it('deletes tag with move_uncategorized', () => {
    const tag = manager.createTag('to-delete');
    const s = manager.createSession('s1', '/tmp', tag.id);
    manager.deleteTag(tag.id, 'move_uncategorized');
    expect(manager.getSession(s.id)!.tagId).toBe('uncategorized');
    expect(manager.listTags().find(t => t.id === tag.id)).toBeUndefined();
  });
});
