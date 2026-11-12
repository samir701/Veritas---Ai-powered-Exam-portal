import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

const { Pool, types } = pg;

// Parse PostgreSQL int8 / BIGINT (and COUNT(*)) as JavaScript numbers to match SQLite behavior.
types.setTypeParser(20, (val) => (val === null ? null : Number(val)));

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 10000;

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    retention_days INTEGER NOT NULL DEFAULT 90,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'interviewer', 'reviewer')),
    password_hash TEXT NOT NULL,
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    mfa_secret TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_invites (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'interviewer', 'reviewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    mfa_verified INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    pool_tag TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    points REAL NOT NULL DEFAULT 1.0,
    negative_points REAL NOT NULL DEFAULT 0.0,
    explanation TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS question_options (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    passing_score_percent REAL NOT NULL DEFAULT 70.0,
    draw_count INTEGER,
    pool_tag TEXT NOT NULL DEFAULT '',
    shuffle_questions INTEGER NOT NULL DEFAULT 1,
    shuffle_options INTEGER NOT NULL DEFAULT 1,
    require_fullscreen INTEGER NOT NULL DEFAULT 1,
    auto_submit_on_violation INTEGER NOT NULL DEFAULT 1,
    lock_copy_paste INTEGER NOT NULL DEFAULT 1,
    require_webcam_check INTEGER NOT NULL DEFAULT 0,
    require_live_webcam INTEGER NOT NULL DEFAULT 0,
    allow_non_webcam_alternative INTEGER NOT NULL DEFAULT 1,
    allowed_materials TEXT NOT NULL DEFAULT 'No external assistance or unauthorized reference materials unless explicitly permitted by the interviewer.',
    rules_text TEXT NOT NULL DEFAULT 'Complete this assessment independently within the allotted time. Your answers are autosaved continuously. Exiting fullscreen or switching tabs may auto-submit your exam.',
    privacy_notice TEXT NOT NULL DEFAULT 'We collect your exam responses, timestamps, device compatibility checks, and browser session events solely to administer and evaluate this assessment fairly.',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    points_override REAL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (exam_id, question_id)
);

CREATE TABLE IF NOT EXISTS candidate_invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    candidate_name TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    extra_time_minutes INTEGER NOT NULL DEFAULT 0,
    accommodation_notes TEXT NOT NULL DEFAULT '',
    webcam_waived INTEGER NOT NULL DEFAULT 0,
    require_live_webcam INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'completed', 'revoked', 'anonymized')),
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    invitation_id TEXT NOT NULL UNIQUE REFERENCES candidate_invitations(id) ON DELETE CASCADE,
    candidate_name TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'timed_out')),
    consent_accepted_at INTEGER NOT NULL,
    webcam_consent_choice TEXT NOT NULL DEFAULT 'not_required' CHECK (webcam_consent_choice IN ('not_required', 'consented', 'alternative_requested', 'waived')),
    device_check_json TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    submitted_at INTEGER,
    submit_reason TEXT NOT NULL DEFAULT '',
    live_webcam_active INTEGER NOT NULL DEFAULT 0,
    live_webcam_token TEXT,
    score_earned REAL,
    score_possible REAL,
    score_percent REAL,
    passed INTEGER,
    reviewer_notes TEXT NOT NULL DEFAULT '',
    is_anonymized INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt_questions (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL,
    option_order_json TEXT NOT NULL,
    points_possible REAL NOT NULL,
    negative_points REAL NOT NULL DEFAULT 0.0,
    selected_option_id TEXT,
    is_correct INTEGER,
    points_awarded REAL,
    answered_at INTEGER,
    UNIQUE (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    occurred_at INTEGER NOT NULL,
    server_received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS live_webcam_frames (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
    frame_data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_questions_org ON questions(organization_id, pool_tag);
CREATE INDEX IF NOT EXISTS idx_exams_org ON exams(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invites_org_exam ON candidate_invitations(organization_id, exam_id);
CREATE INDEX IF NOT EXISTS idx_attempts_org_exam ON attempts(organization_id, exam_id, status);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON session_events(attempt_id, server_received_at);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at DESC);
`;

export const SCHEMA_PG_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    retention_days INTEGER NOT NULL DEFAULT 90,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'interviewer', 'reviewer')),
    password_hash TEXT NOT NULL,
    mfa_enabled INTEGER NOT NULL DEFAULT 0,
    mfa_secret TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_invites (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'interviewer', 'reviewer')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at BIGINT NOT NULL,
    accepted_at BIGINT,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    mfa_verified INTEGER NOT NULL DEFAULT 1,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    pool_tag TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    points DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    negative_points DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    explanation TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_options (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    passing_score_percent DOUBLE PRECISION NOT NULL DEFAULT 70.0,
    draw_count INTEGER,
    pool_tag TEXT NOT NULL DEFAULT '',
    shuffle_questions INTEGER NOT NULL DEFAULT 1,
    shuffle_options INTEGER NOT NULL DEFAULT 1,
    require_fullscreen INTEGER NOT NULL DEFAULT 1,
    auto_submit_on_violation INTEGER NOT NULL DEFAULT 1,
    lock_copy_paste INTEGER NOT NULL DEFAULT 1,
    require_webcam_check INTEGER NOT NULL DEFAULT 0,
    require_live_webcam INTEGER NOT NULL DEFAULT 0,
    allow_non_webcam_alternative INTEGER NOT NULL DEFAULT 1,
    allowed_materials TEXT NOT NULL DEFAULT 'No external assistance or unauthorized reference materials unless explicitly permitted by the interviewer.',
    rules_text TEXT NOT NULL DEFAULT 'Complete this assessment independently within the allotted time. Your answers are autosaved continuously. Exiting fullscreen or switching tabs may auto-submit your exam.',
    privacy_notice TEXT NOT NULL DEFAULT 'We collect your exam responses, timestamps, device compatibility checks, and browser session events solely to administer and evaluate this assessment fairly.',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_questions (
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    points_override DOUBLE PRECISION,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (exam_id, question_id)
);

CREATE TABLE IF NOT EXISTS candidate_invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    candidate_name TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    extra_time_minutes INTEGER NOT NULL DEFAULT 0,
    accommodation_notes TEXT NOT NULL DEFAULT '',
    webcam_waived INTEGER NOT NULL DEFAULT 0,
    require_live_webcam INTEGER NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'completed', 'revoked', 'anonymized')),
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    invitation_id TEXT NOT NULL UNIQUE REFERENCES candidate_invitations(id) ON DELETE CASCADE,
    candidate_name TEXT NOT NULL,
    candidate_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'timed_out')),
    consent_accepted_at BIGINT NOT NULL,
    webcam_consent_choice TEXT NOT NULL DEFAULT 'not_required' CHECK (webcam_consent_choice IN ('not_required', 'consented', 'alternative_requested', 'waived')),
    device_check_json TEXT NOT NULL DEFAULT '{}',
    started_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    submitted_at BIGINT,
    submit_reason TEXT NOT NULL DEFAULT '',
    live_webcam_active INTEGER NOT NULL DEFAULT 0,
    live_webcam_token TEXT,
    score_earned DOUBLE PRECISION,
    score_possible DOUBLE PRECISION,
    score_percent DOUBLE PRECISION,
    passed INTEGER,
    reviewer_notes TEXT NOT NULL DEFAULT '',
    is_anonymized INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt_questions (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    display_order INTEGER NOT NULL,
    option_order_json TEXT NOT NULL,
    points_possible DOUBLE PRECISION NOT NULL,
    negative_points DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    selected_option_id TEXT,
    is_correct INTEGER,
    points_awarded DOUBLE PRECISION,
    answered_at BIGINT,
    UNIQUE (attempt_id, question_id)
);

CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    occurred_at BIGINT NOT NULL,
    server_received_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_webcam_frames (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
    frame_data BYTEA NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_questions_org ON questions(organization_id, pool_tag);
CREATE INDEX IF NOT EXISTS idx_exams_org ON exams(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invites_org_exam ON candidate_invitations(organization_id, exam_id);
CREATE INDEX IF NOT EXISTS idx_attempts_org_exam ON attempts(organization_id, exam_id, status);
CREATE INDEX IF NOT EXISTS idx_events_attempt ON session_events(attempt_id, server_received_at);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(organization_id, created_at DESC);

ALTER TABLE exams ADD COLUMN IF NOT EXISTS auto_submit_on_violation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS lock_copy_paste INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS require_live_webcam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE candidate_invitations ADD COLUMN IF NOT EXISTS require_live_webcam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS submit_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS live_webcam_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS live_webcam_token TEXT;
`;

export function nowTs() {
  return Math.floor(Date.now() / 1000);
}

export function utcIso(ts) {
  if (ts === null || ts === undefined) return null;
  return new Date(Number(ts) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Translate SQLite-style `?` placeholders outside single-quoted string literals to PostgreSQL `$1, $2, ...`.
 */
export function translateSqlToPg(sql) {
  let out = "";
  let idx = 0;
  let inSingle = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      if (inSingle && sql[i + 1] === "'") {
        out += "'";
        i += 1;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }
    if (ch === "?" && !inSingle) {
      idx += 1;
      out += `$${idx}`;
      continue;
    }
    out += ch;
  }
  return out;
}

export class Database {
  constructor(dbPath) {
    this.dialect = "sqlite";
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.conn = new DatabaseSync(this.dbPath);
    this._initialized = false;
    this.initSchema();
  }

  initSchema() {
    this.conn.exec(SCHEMA_SQL);
    this._ensureColumn("exams", "auto_submit_on_violation", "INTEGER NOT NULL DEFAULT 1");
    this._ensureColumn("exams", "lock_copy_paste", "INTEGER NOT NULL DEFAULT 1");
    this._ensureColumn("exams", "require_live_webcam", "INTEGER NOT NULL DEFAULT 0");
    this._ensureColumn("candidate_invitations", "require_live_webcam", "INTEGER NOT NULL DEFAULT 0");
    this._ensureColumn("attempts", "submit_reason", "TEXT NOT NULL DEFAULT ''");
    this._ensureColumn("attempts", "live_webcam_active", "INTEGER NOT NULL DEFAULT 0");
    this._ensureColumn("attempts", "live_webcam_token", "TEXT");
    this._initialized = true;
  }

  async init() {
    if (!this._initialized) this.initSchema();
  }

  _ensureColumn(table, column, definition) {
    const rows = this.conn.prepare(`PRAGMA table_info(${table})`).all();
    const exists = rows.some((r) => r.name === column);
    if (!exists) {
      this.conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  async get(sql, ...params) {
    return this.conn.prepare(sql).get(...params);
  }

  async all(sql, ...params) {
    return this.conn.prepare(sql).all(...params);
  }

  async run(sql, ...params) {
    return this.conn.prepare(sql).run(...params);
  }

  async transaction(fn) {
    this.conn.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.conn.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.conn.exec("ROLLBACK");
      } catch {
        // ignore rollback error if already rolled back
      }
      throw err;
    }
  }

  async close() {
    this.conn.close();
  }
}

export class PgDatabase {
  constructor(connectionString, { ssl = true } = {}) {
    this.dialect = "postgres";
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 5 : 10)),
      idleTimeoutMillis: 30000,
    });
    this._txStorage = new AsyncLocalStorage();
    this._initPromise = null;
  }

  async init() {
    if (!this._initPromise) {
      this._initPromise = this.pool.query(SCHEMA_PG_SQL).catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    await this._initPromise;
  }

  _activeExecutor() {
    return this._txStorage.getStore() || this.pool;
  }

  async get(sql, ...params) {
    const res = await this._activeExecutor().query(translateSqlToPg(sql), params);
    return res.rows[0];
  }

  async all(sql, ...params) {
    const res = await this._activeExecutor().query(translateSqlToPg(sql), params);
    return res.rows;
  }

  async run(sql, ...params) {
    const res = await this._activeExecutor().query(translateSqlToPg(sql), params);
    return { changes: res.rowCount ?? 0 };
  }

  async transaction(fn) {
    const existingClient = this._txStorage.getStore();
    if (existingClient) {
      return fn(this);
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this._txStorage.run(client, () => fn(this));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function createDatabase(config) {
  if (config?.databaseUrl) {
    return new PgDatabase(config.databaseUrl, { ssl: config.dbSsl !== "0" });
  }
  return new Database(config.dbPath);
}
