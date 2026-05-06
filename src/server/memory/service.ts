import Database from 'better-sqlite3';
import type { SessionRecord, SessionStatus } from '../session/types';

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

      CREATE TABLE IF NOT EXISTS output_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_output_session ON output_log(session_id);
    `);
  }

  createSession(partial: { name: string; cwd: string; status: SessionStatus }): SessionRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const record: SessionRecord = {
      id,
      name: partial.name,
      cwd: partial.cwd,
      status: partial.status,
      created_at: now,
      last_active_at: now,
    };
    this.db.prepare(
      `INSERT INTO sessions (id, name, cwd, status, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(record.id, record.name, record.cwd, record.status, record.created_at, record.last_active_at);
    return record;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`).all() as SessionRecord[];
  }

  updateSession(id: string, changes: Partial<Pick<SessionRecord, 'name' | 'status' | 'last_active_at'>>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); values.push(changes.name); }
    if (changes.status !== undefined) { sets.push('status = ?'); values.push(changes.status); }
    if (changes.last_active_at !== undefined) { sets.push('last_active_at = ?'); values.push(changes.last_active_at); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM output_log WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  getCwdSuggestions(): string[] {
    const rows = this.db.prepare(`SELECT cwd FROM sessions GROUP BY cwd ORDER BY COUNT(*) DESC LIMIT 10`).all() as { cwd: string }[];
    return rows.map(r => r.cwd);
  }

  loadNonStoppedSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT * FROM sessions WHERE status != 'stopped' ORDER BY last_active_at DESC`).all() as SessionRecord[];
  }

  appendOutput(sessionId: string, data: string): void {
    this.db.prepare(
      `INSERT INTO output_log (session_id, data, created_at) VALUES (?, ?, ?)`
    ).run(sessionId, data, Date.now());
  }

  getOutputHistory(sessionId: string, limit = 10000): string[] {
    const rows = this.db.prepare(
      `SELECT data FROM output_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(sessionId, limit) as { data: string }[];
    return rows.map(r => r.data).reverse();
  }

  close(): void {
    this.db.close();
  }
}
