import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowIso, DATA_DIR } from './db.js';

/**
 * Attachment storage.
 *
 * Files live under `data/attachments/<id>__<safe-name>` and are described by a
 * row in the `attachments` table. Buffers are only read at send time, so a large
 * campaign does not hold every attachment in memory.
 *
 * Security posture: filenames are sanitised and never used as a path, the stored
 * name is derived from a random id, reads are verified to resolve inside the
 * attachment directory (defence against traversal), and a strict size limit is
 * enforced before anything touches the disk.
 */

export const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

/** Per-file ceiling. Mail providers reject far above this. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Ceiling for all attachments on one message. */
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
/** Ceiling for the whole upload request. */
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

/** Attachments that make no sense to mail and could surprise a recipient. */
const BLOCKED_EXTENSIONS = new Set([
  '.ade', '.adp', '.app', '.bat', '.chm', '.cmd', '.com', '.cpl', '.dll', '.exe',
  '.gadget', '.hta', '.inf', '.ins', '.isp', '.jar', '.js', '.jse', '.lib', '.lnk',
  '.mde', '.msc', '.msi', '.msp', '.mst', '.pif', '.ps1', '.scr', '.sct', '.shb',
  '.sys', '.vb', '.vbe', '.vbs', '.vxd', '.wsf', '.wsh',
]);

let ensured = false;
function ensureDir() {
  if (!ensured) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    ensured = true;
  }
  return ATTACHMENTS_DIR;
}

/**
 * Strip anything path-like or control-character-like from a display name.
 * The result is only ever shown to the user and written into the MIME headers.
 */
export function sanitizeFilename(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  const cleaned = base
    // Control characters can break or forge MIME headers.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["<>|:*?]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const limited = cleaned.slice(0, 180);
  return limited || 'attachment';
}

export function extensionOf(name) {
  return path.extname(String(name ?? '')).toLowerCase();
}

/**
 * Validate an incoming file. Returns an error string, or null when acceptable.
 * @param {{originalname: string, size: number}} file
 */
export function validateUpload(file) {
  const name = sanitizeFilename(file.originalname);
  if (BLOCKED_EXTENSIONS.has(extensionOf(name))) {
    return `"${name}" is an executable file type, which mail providers block and recipients should not be sent.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `"${name}" is ${formatBytes(file.size)}, larger than the ${formatBytes(MAX_FILE_BYTES)} per-file limit.`;
  }
  return null;
}

/** Persist one uploaded file (multer memory storage) and describe it. */
export function saveAttachment(file) {
  const dir = ensureDir();
  const displayName = sanitizeFilename(file.originalname);
  const storedName = `${crypto.randomBytes(12).toString('hex')}__${displayName}`;
  const target = path.join(dir, storedName);

  fs.writeFileSync(target, file.buffer);

  const info = db
    .prepare(
      `INSERT INTO attachments (filename, stored_name, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      displayName,
      storedName,
      String(file.mimetype || 'application/octet-stream'),
      file.buffer.length,
      nowIso(),
    );

  return attachmentRow(db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid));
}

export function attachmentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

export function getAttachment(id) {
  return db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id)) ?? null;
}

export function listAttachments({ limit = 100, offset = 0 } = {}) {
  const rows = db
    .prepare('SELECT * FROM attachments ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
  return rows.map(attachmentRow);
}

/**
 * Absolute path for an attachment's bytes, or null when the file is missing.
 * Resolves and verifies the result stays inside the attachment directory.
 */
export function attachmentPath(id) {
  const row = getAttachment(id);
  if (!row) return null;

  const resolved = path.resolve(ATTACHMENTS_DIR, row.stored_name);
  const root = path.resolve(ATTACHMENTS_DIR);
  if (!resolved.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;

  return { path: resolved, row };
}

/**
 * Build the nodemailer attachment objects for a campaign.
 * Missing files are skipped and reported rather than failing the whole send.
 */
export function resolveCampaignAttachments(campaignId) {
  const rows = db
    .prepare(
      `SELECT a.* FROM campaign_attachments ca
       JOIN attachments a ON a.id = ca.attachment_id
       WHERE ca.campaign_id = ?
       ORDER BY ca.position ASC`,
    )
    .all(Number(campaignId));

  const attachments = [];
  const missing = [];

  for (const row of rows) {
    const found = attachmentPath(row.id);
    if (!found) {
      missing.push(row.filename);
      continue;
    }
    attachments.push({
      filename: row.filename,
      content: fs.readFileSync(found.path),
      contentType: row.content_type,
    });
  }

  return { attachments, missing };
}

export function linkAttachments(campaignId, attachmentIds) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO campaign_attachments (campaign_id, attachment_id, position) VALUES (?, ?, ?)',
  );
  attachmentIds.forEach((id, index) => insert.run(Number(campaignId), Number(id), index));
}

export function deleteAttachment(id) {
  const row = getAttachment(id);
  if (!row) return false;

  const resolved = path.resolve(ATTACHMENTS_DIR, row.stored_name);
  const root = path.resolve(ATTACHMENTS_DIR);
  if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  return true;
}

/** Remove attachment rows (and files) that no campaign or draft refers to. */
export function pruneOrphanAttachments({ olderThanHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const orphans = db
    .prepare(
      `SELECT a.id, a.stored_name, a.filename FROM attachments a
       WHERE a.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM campaign_attachments ca WHERE ca.attachment_id = a.id)
         AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.attachments LIKE '%' || a.id || '%')`,
    )
    .all(cutoff);

  for (const orphan of orphans) {
    deleteAttachment(orphan.id);
  }
  return orphans.length;
}

export function totalBytesOf(ids) {
  if (!ids?.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE id IN (${placeholders})`)
    .get(...ids.map(Number));
  return row?.total ?? 0;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export const BLOCKED = BLOCKED_EXTENSIONS;
