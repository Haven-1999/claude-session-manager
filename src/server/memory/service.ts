import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { SessionRecord, SessionStatus, Tag, TagRecord } from '../session/types';
import { UNCATEGORIZED_TAG_ID } from '../session/types';

export class MemoryService {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'disconnected', 'stopped')),
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
    `);
    // Migration: add claude_session_id column if missing
    const hasClaudeCol = this.db.prepare(`SELECT COUNT(*) as count FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'`).get() as { count: number };
    if (hasClaudeCol.count === 0) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN claude_session_id TEXT`);
    }

    // Migration: create tags table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    // Migration: add tag_id column to sessions if missing
    const hasTagCol = this.db.prepare(`SELECT COUNT(*) as count FROM pragma_table_info('sessions') WHERE name = 'tag_id'`).get() as { count: number };
    if (hasTagCol.count === 0) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN tag_id TEXT`);
    }

    // Ensure uncategorized tag exists
    this.ensureUncategorizedTag();

    // Migrate orphaned sessions to uncategorized
    this.db.prepare(`UPDATE sessions SET tag_id = ? WHERE tag_id IS NULL`).run(UNCATEGORIZED_TAG_ID);
  }

  private ensureUncategorizedTag(): void {
    const exists = this.db.prepare(`SELECT id FROM tags WHERE id = ?`).get(UNCATEGORIZED_TAG_ID);
    if (!exists) {
      this.db.prepare(
        `INSERT INTO tags (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`
      ).run(UNCATEGORIZED_TAG_ID, '未分类', 999999, Date.now());
    }
  }

  // --- Tag methods ---

  createTag(name: string): Tag {
    const id = crypto.randomUUID();
    const now = Date.now();
    const maxOrder = this.db.prepare(`SELECT COALESCE(MAX(sort_order), 0) as max_order FROM tags WHERE id != ?`).get(UNCATEGORIZED_TAG_ID) as { max_order: number };
    const sortOrder = maxOrder.max_order + 1;
    this.db.prepare(
      `INSERT INTO tags (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, name, sortOrder, now);
    return { id, name, sortOrder, createdAt: now };
  }

  listTags(): Tag[] {
    const rows = this.db.prepare(`SELECT * FROM tags ORDER BY CASE WHEN id = ? THEN 1 ELSE 0 END, sort_order ASC`).all(UNCATEGORIZED_TAG_ID) as TagRecord[];
    return rows.map(r => ({ id: r.id, name: r.name, sortOrder: r.sort_order, createdAt: r.created_at }));
  }

  getTag(id: string): Tag | undefined {
    const row = this.db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as TagRecord | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at };
  }

  updateTag(id: string, changes: { name?: string }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); values.push(changes.name); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteTag(id: string): void {
    this.db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  }

  moveSessionsToTag(fromTagId: string, toTagId: string): void {
    this.db.prepare(`UPDATE sessions SET tag_id = ? WHERE tag_id = ?`).run(toTagId, fromTagId);
  }

  deleteSessionsByTag(tagId: string): string[] {
    const rows = this.db.prepare(`SELECT id FROM sessions WHERE tag_id = ?`).all(tagId) as { id: string }[];
    const ids = rows.map(r => r.id);
    this.db.prepare(`DELETE FROM sessions WHERE tag_id = ?`).run(tagId);
    return ids;
  }

  // --- Path completion ---

  listDirectories(partial: string): string[] {
    if (!partial || !path.isAbsolute(partial)) return [];
    const dir = partial.endsWith('/') ? partial : path.dirname(partial);
    const prefix = partial.endsWith('/') ? '' : path.basename(partial);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name.startsWith(prefix))
        .map(e => path.join(dir, e.name))
        .slice(0, 20);
      return dirs;
    } catch {
      return [];
    }
  }

  // --- Session methods ---

  createSession(partial: { name: string; cwd: string; status: SessionStatus; claude_session_id?: string | null; tag_id: string }): SessionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const record: SessionRecord = {
      id,
      name: partial.name,
      cwd: partial.cwd,
      status: partial.status,
      created_at: now,
      last_active_at: now,
      claude_session_id: partial.claude_session_id ?? null,
      tag_id: partial.tag_id,
    };
    this.db.prepare(
      `INSERT INTO sessions (id, name, cwd, status, created_at, last_active_at, claude_session_id, tag_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(record.id, record.name, record.cwd, record.status, record.created_at, record.last_active_at, record.claude_session_id, record.tag_id);
    return record;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`).all() as SessionRecord[];
  }

  updateSession(id: string, changes: Partial<Pick<SessionRecord, 'name' | 'status' | 'last_active_at' | 'claude_session_id' | 'tag_id'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); values.push(changes.name); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.last_active_at !== undefined) { sets.push('last_active_at = ?'); values.push(changes.last_active_at); }
    if (changes.claude_session_id !== undefined) { sets.push('claude_session_id = ?'); values.push(changes.claude_session_id); }
    if (changes.tag_id !== undefined) { sets.push('tag_id = ?'); values.push(changes.tag_id); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  getCwdSuggestions(): string[] {
    const rows = this.db.prepare(`SELECT cwd FROM sessions GROUP BY cwd ORDER BY COUNT(*) DESC LIMIT 10`).all() as { cwd: string }[];
    return rows.map(r => r.cwd);
  }

  loadAllSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`).all() as SessionRecord[];
  }

  close(): void {
    this.db.close();
  }
}
