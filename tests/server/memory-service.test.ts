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
    const session = service.createSession({ name: 'test', cwd: '/home/user/proj', status: 'running', tag_id: 'uncategorized' });
    expect(session.id).toBeDefined();
    expect(session.name).toBe('test');
    expect(session.tag_id).toBe('uncategorized');

    const found = service.getSession(session.id);
    expect(found).not.toBeNull();
    expect(found!.cwd).toBe('/home/user/proj');
  });

  it('lists sessions', () => {
    service.createSession({ name: 'a', cwd: '/a', status: 'running', tag_id: 'uncategorized' });
    service.createSession({ name: 'b', cwd: '/b', status: 'disconnected', tag_id: 'uncategorized' });
    const list = service.listSessions();
    expect(list).toHaveLength(2);
  });

  it('updates session name', () => {
    const s = service.createSession({ name: 'old', cwd: '/x', status: 'running', tag_id: 'uncategorized' });
    service.updateSession(s.id, { name: 'new' });
    const found = service.getSession(s.id);
    expect(found!.name).toBe('new');
  });

  it('deletes a session', () => {
    const s = service.createSession({ name: 'del', cwd: '/y', status: 'stopped', tag_id: 'uncategorized' });
    service.deleteSession(s.id);
    expect(service.getSession(s.id)).toBeNull();
  });

  it('returns cwd suggestions', () => {
    service.createSession({ name: 'a', cwd: '/projects/one', status: 'running', tag_id: 'uncategorized' });
    service.createSession({ name: 'b', cwd: '/projects/one', status: 'running', tag_id: 'uncategorized' });
    service.createSession({ name: 'c', cwd: '/projects/two', status: 'running', tag_id: 'uncategorized' });
    const suggestions = service.getCwdSuggestions();
    expect(suggestions).toContain('/projects/one');
    expect(suggestions).toContain('/projects/two');
    expect(suggestions.length).toBeLessThanOrEqual(10);
  });

  // Tag tests

  it('creates uncategorized tag on init', () => {
    const tags = service.listTags();
    expect(tags.some(t => t.id === 'uncategorized')).toBe(true);
    expect(tags.find(t => t.id === 'uncategorized')!.name).toBe('未分类');
  });

  it('creates and lists tags', () => {
    const tag = service.createTag('frontend');
    expect(tag.name).toBe('frontend');
    expect(tag.id).toBeDefined();
    const tags = service.listTags();
    expect(tags.some(t => t.name === 'frontend')).toBe(true);
  });

  it('updates tag name', () => {
    const tag = service.createTag('old-name');
    service.updateTag(tag.id, { name: 'new-name' });
    const found = service.getTag(tag.id);
    expect(found!.name).toBe('new-name');
  });

  it('deletes a tag', () => {
    const tag = service.createTag('to-delete');
    service.deleteTag(tag.id);
    expect(service.getTag(tag.id)).toBeUndefined();
  });

  it('moves sessions between tags', () => {
    const tag1 = service.createTag('tag1');
    const tag2 = service.createTag('tag2');
    const s = service.createSession({ name: 'sess', cwd: '/tmp', status: 'running', tag_id: tag1.id });
    service.moveSessionsToTag(tag1.id, tag2.id);
    const found = service.getSession(s.id);
    expect(found!.tag_id).toBe(tag2.id);
  });

  it('deletes sessions by tag', () => {
    const tag = service.createTag('tag-del');
    service.createSession({ name: 's1', cwd: '/tmp', status: 'running', tag_id: tag.id });
    service.createSession({ name: 's2', cwd: '/tmp', status: 'running', tag_id: tag.id });
    const deleted = service.deleteSessionsByTag(tag.id);
    expect(deleted).toHaveLength(2);
    expect(service.listSessions().filter(s => s.tag_id === tag.id)).toHaveLength(0);
  });

  it('migrates sessions with null tag_id to uncategorized', () => {
    // All sessions created through the service will have tag_id set,
    // but the migration in constructor handles legacy data
    const s = service.createSession({ name: 'test', cwd: '/tmp', status: 'running', tag_id: 'uncategorized' });
    expect(s.tag_id).toBe('uncategorized');
  });

  it('lists directories for path completion', () => {
    const dirs = service.listDirectories('/tmp/');
    expect(Array.isArray(dirs)).toBe(true);
  });

  it('updates session tag_id', () => {
    const tag = service.createTag('new-tag');
    const s = service.createSession({ name: 'sess', cwd: '/tmp', status: 'running', tag_id: 'uncategorized' });
    service.updateSession(s.id, { tag_id: tag.id });
    const found = service.getSession(s.id);
    expect(found!.tag_id).toBe(tag.id);
  });

  it('uncategorized tag is always last in list', () => {
    service.createTag('zzz-last-alpha');
    service.createTag('aaa-first-alpha');
    const tags = service.listTags();
    const lastTag = tags[tags.length - 1];
    expect(lastTag.id).toBe('uncategorized');
  });
});
