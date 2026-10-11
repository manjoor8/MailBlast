import express from 'express';
import { db, nowIso, normalizeTags, tagsToText } from './db.js';
import { sanitizeEmailHtml } from './sanitize.js';

/**
 * Saved compose drafts.
 *
 * A draft holds everything needed to resume writing: the message, the sender
 * name, personalization settings and which contacts it was aimed at. It is
 * deliberately independent of the send queue — saving a draft never sends mail.
 */

export function draftRow(row) {
  if (!row) return null;

  const parseIds = (value) => {
    try {
      const parsed = JSON.parse(value || '[]');
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  };

  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    html: row.html,
    fromName: row.from_name,
    personalize: Boolean(row.personalize),
    delayMs: row.delay_ms,
    recipientMode: row.recipient_mode,
    tags: normalizeTags(row.tags),
    manual: row.manual,
    /** Ticked contact ids — the current recipient model. */
    selectedIds: parseIds(row.selected_ids),
    attachmentIds: parseIds(row.attachments),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A human-friendly fallback so an untitled draft is still identifiable. */
function deriveName(name, subject, html) {
  const explicit = String(name ?? '').trim();
  if (explicit) return explicit.slice(0, 120);

  const fromSubject = String(subject ?? '').trim();
  if (fromSubject) return fromSubject.slice(0, 120);

  const text = String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 60) : 'Untitled draft';
}

function readBody(body = {}) {
  const idList = (value) =>
    JSON.stringify(Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []);

  return {
    name: deriveName(body.name, body.subject, body.html),
    subject: String(body.subject ?? ''),
    // Drafts are sanitised on save so a resumed draft cannot smuggle markup in.
    html: sanitizeEmailHtml(body.html ?? ''),
    fromName: String(body.fromName ?? '').trim(),
    personalize: body.personalize === false ? 0 : 1,
    delayMs: Math.max(0, Number(body.delayMs) || 0),
    recipientMode: ['all', 'tags', 'manual'].includes(body.recipientMode) ? body.recipientMode : 'all',
    tags: tagsToText(body.tags),
    manual: String(body.manual ?? ''),
    selectedIds: idList(body.selectedIds),
    attachments: idList(body.attachmentIds),
  };
}

export function createDraftsRouter() {
  const router = express.Router();

  router.get('/api/drafts', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);

    const where = q ? 'WHERE name LIKE ? OR subject LIKE ? OR html LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];

    const total = db.prepare(`SELECT COUNT(*) AS n FROM drafts ${where}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM drafts ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit);

    res.json({ total, drafts: rows.map(draftRow) });
  });

  router.get('/api/drafts/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Draft not found.' });
    res.json(draftRow(row));
  });

  router.post('/api/drafts', (req, res) => {
    const data = readBody(req.body);
    const ts = nowIso();

    const info = db
      .prepare(
        `INSERT INTO drafts
           (name, subject, html, from_name, personalize, delay_ms, recipient_mode, tags, manual, selected_ids, attachments, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.name, data.subject, data.html, data.fromName, data.personalize,
        data.delayMs, data.recipientMode, data.tags, data.manual, data.selectedIds,
        data.attachments, ts, ts,
      );

    const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ok: true, draft: draftRow(row) });
  });

  router.put('/api/drafts/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Draft not found.' });

    const data = readBody(req.body);
    db.prepare(
      `UPDATE drafts SET name = ?, subject = ?, html = ?, from_name = ?, personalize = ?,
         delay_ms = ?, recipient_mode = ?, tags = ?, manual = ?, selected_ids = ?, attachments = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      data.name, data.subject, data.html, data.fromName, data.personalize,
      data.delayMs, data.recipientMode, data.tags, data.manual, data.selectedIds,
      data.attachments, nowIso(), id,
    );

    res.json({ ok: true, draft: draftRow(db.prepare('SELECT * FROM drafts WHERE id = ?').get(id)) });
  });

  router.delete('/api/drafts/:id', (req, res) => {
    const info = db.prepare('DELETE FROM drafts WHERE id = ?').run(Number(req.params.id));
    if (!info.changes) return res.status(404).json({ error: 'Draft not found.' });
    res.json({ ok: true, deleted: info.changes });
  });

  /** Copy a draft, so an old version can be kept while editing a new one. */
  router.post('/api/drafts/:id/duplicate', (req, res) => {
    const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Draft not found.' });

    const ts = nowIso();
    const info = db
      .prepare(
        `INSERT INTO drafts
           (name, subject, html, from_name, personalize, delay_ms, recipient_mode, tags, manual, selected_ids, attachments, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${row.name} (copy)`, row.subject, row.html, row.from_name, row.personalize,
        row.delay_ms, row.recipient_mode, row.tags, row.manual, row.selected_ids,
        row.attachments, ts, ts,
      );

    res.status(201).json({ ok: true, draft: draftRow(db.prepare('SELECT * FROM drafts WHERE id = ?').get(info.lastInsertRowid)) });
  });

  return router;
}

export default createDraftsRouter;
