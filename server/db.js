import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'mailblast.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL DEFAULT '',
    email      TEXT    NOT NULL,
    company    TEXT    NOT NULL DEFAULT '',
    tags       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts (lower(email));
  CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts (name);

  CREATE TABLE IF NOT EXISTS campaigns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL DEFAULT '',
    subject       TEXT    NOT NULL DEFAULT '',
    html          TEXT    NOT NULL DEFAULT '',
    from_name     TEXT    NOT NULL DEFAULT '',
    reply_to      TEXT    NOT NULL DEFAULT '',
    personalize   INTEGER NOT NULL DEFAULT 1,
    total         INTEGER NOT NULL DEFAULT 0,
    sent          INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'draft',
    created_at    TEXT    NOT NULL,
    finished_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id   INTEGER REFERENCES campaigns (id) ON DELETE SET NULL,
    contact_id    INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
    to_name       TEXT    NOT NULL DEFAULT '',
    to_email      TEXT    NOT NULL,
    subject       TEXT    NOT NULL DEFAULT '',
    html          TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'queued',
    error         TEXT,
    message_id    TEXT,
    response      TEXT,
    transport     TEXT    NOT NULL DEFAULT 'smtp',
    sent_at       TEXT,
    created_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages (sent_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_status  ON messages (status);
  CREATE INDEX IF NOT EXISTS idx_messages_email   ON messages (lower(to_email));

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suppressions (
    email      TEXT PRIMARY KEY,
    reason     TEXT NOT NULL DEFAULT 'bounced',
    created_at TEXT NOT NULL
  );

  /* ------------------------------------------------------------ drafts */

  CREATE TABLE IF NOT EXISTS drafts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT '',
    subject        TEXT    NOT NULL DEFAULT '',
    html           TEXT    NOT NULL DEFAULT '',
    from_name      TEXT    NOT NULL DEFAULT '',
    personalize    INTEGER NOT NULL DEFAULT 1,
    delay_ms       INTEGER NOT NULL DEFAULT 250,
    recipient_mode TEXT    NOT NULL DEFAULT 'all',
    tags           TEXT    NOT NULL DEFAULT '',
    manual         TEXT    NOT NULL DEFAULT '',
    attachments    TEXT    NOT NULL DEFAULT '[]',
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts (updated_at DESC);

  /* ------------------------------------------------------- attachments */

  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT    NOT NULL,
    stored_name   TEXT    NOT NULL,
    content_type  TEXT    NOT NULL DEFAULT 'application/octet-stream',
    size          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments (created_at DESC);

  /** Which attachments belong to a campaign, and in what order. */
  CREATE TABLE IF NOT EXISTS campaign_attachments (
    campaign_id   INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
    attachment_id INTEGER NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
    position      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (campaign_id, attachment_id)
  );
`);

/**
 * Additive migrations for databases created by an earlier version.
 * CREATE TABLE IF NOT EXISTS cannot add a column to an existing table, so new
 * columns are applied here.
 */
function migrate() {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

  if (!columns('drafts').includes('selected_ids')) {
    db.exec("ALTER TABLE drafts ADD COLUMN selected_ids TEXT NOT NULL DEFAULT '[]'");
  }
}

migrate();

export const nowIso = () => new Date().toISOString();

/* ---------------------------------------------------------------- settings */

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value ?? null));
  return value;
}

/* ---------------------------------------------------------------- contacts */

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,;|]/);
  const seen = new Set();
  for (const raw of list) {
    const t = String(raw ?? '').trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export function tagsToText(tags) {
  return normalizeTags(tags).join(', ');
}

export function contactRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    tags: normalizeTags(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertContact({ name = '', email, company = '', tags = [] }, mode = 'merge') {
  const cleanEmail = String(email ?? '').trim();
  if (!cleanEmail) return { ok: false, reason: 'missing-email' };

  const existing = db
    .prepare('SELECT * FROM contacts WHERE lower(email) = lower(?)')
    .get(cleanEmail);

  const ts = nowIso();

  if (existing) {
    if (mode === 'skip') return { ok: true, action: 'skipped', contact: contactRow(existing) };

    const nextName = String(name ?? '').trim() || existing.name;
    const nextCompany = String(company ?? '').trim() || existing.company;
    const mergedTags =
      mode === 'replace'
        ? tagsToText(tags)
        : tagsToText([...normalizeTags(existing.tags), ...normalizeTags(tags)]);

    db.prepare(
      `UPDATE contacts SET name = ?, company = ?, tags = ?, updated_at = ? WHERE id = ?`,
    ).run(nextName, nextCompany, mergedTags, ts, existing.id);

    return {
      ok: true,
      action: 'updated',
      contact: contactRow(db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.id)),
    };
  }

  const info = db
    .prepare(
      `INSERT INTO contacts (name, email, company, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(String(name ?? '').trim(), cleanEmail, String(company ?? '').trim(), tagsToText(tags), ts, ts);

  return {
    ok: true,
    action: 'created',
    contact: contactRow(db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid)),
  };
}

export function isSuppressed(email) {
  return Boolean(
    db.prepare('SELECT 1 AS hit FROM suppressions WHERE lower(email) = lower(?)').get(email),
  );
}

export default db;
