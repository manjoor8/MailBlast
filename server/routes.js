import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import {
  db,
  nowIso,
  getSetting,
  setSetting,
  contactRow,
  upsertContact,
  normalizeTags,
  tagsToText,
  ROOT,
} from './db.js';
import {
  getPublicSmtpConfig,
  saveSmtpConfig,
  resetTransport,
  verifyTransport,
  describeTransport,
  isTransportConfigured,
} from './mailer.js';
import {
  parseContacts,
  toCsv,
  isEmail,
  rowsToContacts,
  parseDelimited,
} from './csv.js';
import { renderMessage, detectTokens, htmlToText, TOKENS } from './personalize.js';
import { sanitizeEmailHtml } from './sanitize.js';
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  saveAttachment,
  listAttachments,
  attachmentPath,
  deleteAttachment,
  validateUpload,
  totalBytesOf,
  formatBytes,
} from './attachments.js';
import { createDraftsRouter } from './drafts.js';
import {
  getPublicOAuthConfig,
  saveOAuthConfig,
  beginAuth,
  completeAuth,
  clearOAuthStore,
  isConsumerAudienceError,
} from './oauth.js';
import { startSend, sendSingle, getJob, listJobs, cancelJob, subscribe, subscribeAll } from './queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

export const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

/* ------------------------------------------------------------------ helpers */

const asInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

function messageRow(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name ?? null,
    contactId: row.contact_id,
    name: row.to_name,
    email: row.to_email,
    subject: row.subject,
    html: row.html,
    status: row.status,
    error: row.error,
    response: row.response,
    transport: row.transport,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------- health */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    transport: describeTransport(),
    configured: isTransportConfigured(),
    counts: {
      contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      sent: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'sent'").get().n,
    },
  });
});

/* -------------------------------------------------------------------- oauth */

app.get('/api/oauth/microsoft/status', (req, res) => {
  res.json(getPublicOAuthConfig(req));
});

app.post('/api/oauth/microsoft/start', (req, res) => {
  try {
    const { url, redirectUri } = beginAuth(req);
    const tenant = new URL(url).pathname.split('/')[1];
    // Log both: when Azure rejects the request, these are the two values it is
    // judging, so they need to be visible without guessing.
    console.log(`[mailblast] OAuth start — tenant: ${tenant}, redirect URI: ${redirectUri}`);
    res.json({ ok: true, url, redirectUri, tenant });
  } catch (err) {
    res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
  }
});

/**
 * Microsoft redirects the browser here after sign-in. This must be a plain GET
 * navigation (not fetch), so it finishes by redirecting back into the SPA.
 */
app.get('/api/oauth/microsoft/callback', async (req, res) => {
  const rawError = String(req.query.error_description ?? req.query.error ?? '');

  // Recoverable: an app set to personal accounts only cannot use /common, so
  // switch to the consumers tenant and try once more. The pending sign-in was
  // already consumed, so this is a clean restart rather than a retry of state.
  if (req.query.error && isConsumerAudienceError(rawError) && !req.query.retried) {
    try {
      saveOAuthConfig({ tenant: 'consumers' });
      resetTransport();
      const { url } = beginAuth(req);
      console.log('[mailblast] tenant "common" rejected for a consumer-only app; retrying with "consumers"');
      return res.redirect(url);
    } catch (retryErr) {
      console.error('[mailblast] automatic tenant switch failed:', retryErr?.message ?? retryErr);
      // Fall through to the normal error page below.
    }
  }

  try {
    const result = await completeAuth(new URLSearchParams(req.query));
    resetTransport();
    const params = new URLSearchParams({ connected: '1', account: result.account ?? '' });
    res.redirect(`/#/settings?${params.toString()}`);
  } catch (err) {
    const message = err?.message ?? String(err);
    console.error('[mailblast] oauth callback failed:', message);
    res.redirect(`/#/settings?oauth_error=${encodeURIComponent(message)}`);
  }
});

app.post('/api/oauth/microsoft/disconnect', (_req, res) => {
  clearOAuthStore();
  resetTransport();
  res.json({ ok: true, ...getPublicOAuthConfig() });
});

/* ----------------------------------------------------------------- settings */

app.get('/api/settings', (req, res) => {
  res.json({
    smtp: getPublicSmtpConfig(),
    oauth: getPublicOAuthConfig(req),
    transport: describeTransport(),
    configured: isTransportConfigured(),
    defaults: getSetting('sendDefaults', { delayMs: 250, personalize: true }),
    tokens: TOKENS,
  });
});

app.put('/api/settings', (req, res) => {
  const body = req.body ?? {};
  if (body.smtp) saveSmtpConfig(body.smtp);
  if (body.oauth) saveOAuthConfig(body.oauth);
  if (body.defaults) setSetting('sendDefaults', { ...getSetting('sendDefaults', {}), ...body.defaults });
  resetTransport();
  res.json({
    smtp: getPublicSmtpConfig(),
    oauth: getPublicOAuthConfig(req),
    transport: describeTransport(),
    configured: isTransportConfigured(),
  });
});

app.post(
  '/api/settings/test',
  wrap(async (_req, res) => {
    try {
      const result = await verifyTransport();
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err?.message ?? String(err) });
    }
  }),
);

/* ----------------------------------------------------------------- contacts */

app.get('/api/contacts', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const tag = String(req.query.tag ?? '').trim();
  const limit = asInt(req.query.limit, 100, 1, 1000);
  const offset = asInt(req.query.offset, 0, 0, 1e9);
  const sort = req.query.sort === 'created' ? 'created_at' : 'name';

  const where = [];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR email LIKE ? OR company LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (tag) {
    where.push("(',' || replace(lower(tags), ', ', ',') || ',' LIKE ?)");
    params.push(`%,${tag.toLowerCase()},%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM contacts ${clause}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM contacts ${clause} ORDER BY ${sort} COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({ total, limit, offset, contacts: rows.map(contactRow) });
});

app.get('/api/contacts/tags', (_req, res) => {
  const counts = new Map();
  for (const row of db.prepare('SELECT tags FROM contacts').all()) {
    for (const tag of normalizeTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  res.json({ tags: [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag)) });
});

app.post('/api/contacts', (req, res) => {
  const { name = '', email = '', company = '', tags = [] } = req.body ?? {};
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  const result = upsertContact({ name, email, company, tags }, 'merge');
  res.status(201).json(result);
});

app.put('/api/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Contact not found.' });

  const { name, email, company, tags } = req.body ?? {};
  const nextEmail = email === undefined ? existing.email : String(email).trim();
  if (!isEmail(nextEmail)) return res.status(400).json({ error: 'A valid email address is required.' });

  const clash = db
    .prepare('SELECT id FROM contacts WHERE lower(email) = lower(?) AND id <> ?')
    .get(nextEmail, id);
  if (clash) return res.status(409).json({ error: 'Another contact already uses that email address.' });

  db.prepare(
    'UPDATE contacts SET name = ?, email = ?, company = ?, tags = ?, updated_at = ? WHERE id = ?',
  ).run(
    name === undefined ? existing.name : String(name).trim(),
    nextEmail,
    company === undefined ? existing.company : String(company).trim(),
    tags === undefined ? existing.tags : tagsToText(tags),
    nowIso(),
    id,
  );

  res.json(contactRow(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)));
});

app.delete('/api/contacts/:id', (req, res) => {
  const info = db.prepare('DELETE FROM contacts WHERE id = ?').run(Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'Contact not found.' });
  res.json({ ok: true, deleted: info.changes });
});

app.post('/api/contacts/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.json({ ok: true, deleted: 0 });
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true, deleted: info.changes });
});

/* ------------------------------------------------------------ csv importing */

/**
 * Import contacts from pasted text or an uploaded CSV.
 *
 * Body: { csv?: string, rows?: string[][], mode?: 'merge'|'skip'|'replace', tags?: string[],
 *         defaultCountry?: never, dryRun?: boolean }
 */
app.post('/api/contacts/import', (req, res) => {
  const { csv, rows, mode = 'merge', tags = [], dryRun = false } = req.body ?? {};

  let parsed;
  if (Array.isArray(rows)) {
    parsed = rowsToContacts(rows.map((r) => (Array.isArray(r) ? r : [r])));
  } else if (typeof csv === 'string' && csv.trim()) {
    parsed = parseContacts(csv);
  } else {
    return res.status(400).json({ error: 'Send either "csv" text or a "rows" array.' });
  }

  const extraTags = normalizeTags(tags);

  // Collapse duplicates inside the file itself, keeping the first occurrence.
  const byEmail = new Map();
  for (const contact of parsed.contacts) {
    const key = contact.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, contact);
    else byEmail.get(key).tags = [...new Set([...byEmail.get(key).tags, ...contact.tags])];
  }
  const unique = [...byEmail.values()];
  const duplicatesInFile = parsed.contacts.length - unique.length;

  if (dryRun) {
    return res.json({
      dryRun: true,
      columns: parsed.columns,
      hadHeader: parsed.hadHeader,
      detected: parsed.contacts.length,
      unique: unique.length,
      duplicatesInFile,
      skipped: parsed.skipped,
      preview: unique.slice(0, 25).map((c) => ({ ...c, tags: [...new Set([...c.tags, ...extraTags])] })),
    });
  }

  let created = 0;
  let updated = 0;
  let skippedExisting = 0;
  const contacts = [];

  db.exec('BEGIN');
  try {
    for (const contact of unique) {
      const merged = { ...contact, tags: [...new Set([...contact.tags, ...extraTags])] };
      const result = upsertContact(merged, mode);
      if (!result.ok) continue;
      if (result.action === 'created') created += 1;
      else if (result.action === 'updated') updated += 1;
      else skippedExisting += 1;
      if (result.contact) contacts.push(result.contact);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({
    ok: true,
    mode,
    columns: parsed.columns,
    hadHeader: parsed.hadHeader,
    detected: parsed.contacts.length,
    unique: unique.length,
    duplicatesInFile,
    created,
    updated,
    skippedExisting,
    totalContacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    skipped: parsed.skipped.slice(0, 50),
    preview: contacts.slice(0, 50),
  });
});

app.get('/api/contacts/export', (_req, res) => {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE').all().map((row) => ({
    name: row.name,
    email: row.email,
    company: row.company,
    tags: row.tags,
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(toCsv(rows, ['name', 'email', 'company', 'tags']));
});

/* --------------------------------------------------------------- attachments */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 10, fields: 20 },
});

const uploadFiles = upload.array('files', 10);

app.get('/api/attachments', (_req, res) => {
  res.json({
    attachments: listAttachments({ limit: 200 }),
    limits: { maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
  });
});

app.post('/api/attachments', (req, res, next) => {
  uploadFiles(req, res, (err) => {
    if (err) {
      // multer signals its size limit with a specific code; translate it.
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `That file is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per-file limit.`
          : err.message;
      return res.status(400).json({ error: message });
    }

    const files = req.files ?? [];
    if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });

    const rejected = [];
    const stored = [];

    for (const file of files) {
      const problem = validateUpload(file);
      if (problem) rejected.push({ filename: file.originalname, reason: problem });
      else stored.push(saveAttachment(file));
    }

    if (!stored.length) {
      return res.status(400).json({ error: rejected.map((r) => r.reason).join(' '), rejected });
    }

    res.status(201).json({ ok: true, attachments: stored, rejected });
  });
});

app.get('/api/attachments/:id/download', (req, res) => {
  const found = attachmentPath(req.params.id);
  if (!found) return res.status(404).json({ error: 'Attachment not found.' });
  res.download(found.path, found.row.filename);
});

app.delete('/api/attachments/:id', (req, res) => {
  const removed = deleteAttachment(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Attachment not found.' });
  res.json({ ok: true });
});

/* -------------------------------------------------------------------- drafts */

app.use(createDraftsRouter());

/* ------------------------------------------------------------------- preview */

app.post('/api/preview', (req, res) => {
  const { subject = '', html = '', contact = {}, personalize = true } = req.body ?? {};
  const sample = {
    name: contact.name || 'Ada Lovelace',
    email: contact.email || 'ada@example.com',
    company: contact.company || 'Analytical Engines Ltd',
  };
  // Sanitise before rendering so the preview matches what would actually send.
  const safeHtml = sanitizeEmailHtml(html);
  const rendered = renderMessage({ subject, html: safeHtml, contact: sample, personalize });
  res.json({
    subject: rendered.subject,
    html: rendered.html,
    text: htmlToText(rendered.html),
    sample,
    tokens: detectTokens(subject, safeHtml),
  });
});

/* -------------------------------------------------------------------- sending */

app.post('/api/send', (req, res) => {
  const {
    subject = '', html = '', recipients = [], personalize = true,
    delayMs = 250, campaignName = '', attachmentIds = [],
  } = req.body ?? {};

  const cleaned = recipients
    .map((r) => ({
      id: r?.id ?? null,
      name: String(r?.name ?? '').trim(),
      email: String(r?.email ?? '').trim(),
      company: String(r?.company ?? '').trim(),
    }))
    .filter((r) => isEmail(r.email));

  const invalid = recipients.length - cleaned.length;
  if (!cleaned.length) {
    return res.status(400).json({ error: 'No valid recipient email addresses were provided.' });
  }

  // Validate attachments up front: a missing file or an oversized set should
  // fail the request, not fail every individual message in the campaign.
  const wanted = (Array.isArray(attachmentIds) ? attachmentIds : []).map(Number).filter(Number.isFinite);
  const usable = [];
  for (const id of wanted) {
    const found = attachmentPath(id);
    if (found) usable.push(id);
    else console.warn(`[mailblast] attachment ${id} is missing from disk; sending without it`);
  }

  const totalBytes = totalBytesOf(usable);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return res.status(400).json({
      error: `Those attachments total ${formatBytes(totalBytes)}, over the ${formatBytes(MAX_TOTAL_BYTES)} limit for one message.`,
    });
  }

  try {
    // Sanitise once here so every downstream path (queue, history, resend) is clean.
    const job = startSend({
      subject,
      html: sanitizeEmailHtml(html),
      recipients: cleaned,
      personalize: Boolean(personalize),
      delayMs: asInt(delayMs, 250, 0, 60_000),
      campaignName,
      attachmentIds: usable,
    });
    res.status(202).json({
      ok: true,
      invalidSkipped: invalid,
      attachmentCount: usable.length,
      attachmentBytes: totalBytes,
      job,
    });
  } catch (err) {
    res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
  }
});

app.post(
  '/api/send/test',
  wrap(async (req, res) => {
    const { to, subject = 'MailBlast test message', html = '<p>Your SMTP settings work. 🎉</p>' } = req.body ?? {};
    if (!isEmail(to)) return res.status(400).json({ error: 'Enter a valid test recipient address.' });
    const result = await sendSingle({
      to,
      toName: 'Test recipient',
      subject,
      html: sanitizeEmailHtml(html),
    });
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

app.post(
  '/api/messages/:id/resend',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const original = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!original) return res.status(404).json({ error: 'Message not found.' });

    const to = String(req.body?.to ?? original.to_email).trim();
    if (!isEmail(to)) return res.status(400).json({ error: 'Enter a valid recipient address.' });

    const result = await sendSingle({
      to,
      toName: original.to_name,
      subject: original.subject,
      html: original.html,
      contactId: original.contact_id,
      campaignId: original.campaign_id,
    });
    res.status(result.ok ? 200 : 502).json(result);
  }),
);

/* ---------------------------------------------------------------------- jobs */

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listJobs() });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have been cleared by a restart).' });
  res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ ok: true, job });
});

/** Live progress stream (server-sent events). */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const jobId = req.query.job ? String(req.query.job) : null;
  const send = (payload) => {
    res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = jobId ? subscribe(jobId, send) : subscribeAll(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);

  if (jobId) {
    const job = getJob(jobId);
    if (job) send(job);
  }

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

/* ------------------------------------------------------------------- history */

function historyQuery(query) {
  const q = String(query.q ?? '').trim();
  const status = String(query.status ?? '').trim();
  const campaignId = query.campaignId ? Number(query.campaignId) : null;
  const from = String(query.from ?? '').trim();
  const to = String(query.to ?? '').trim();

  const where = [];
  const params = [];

  if (q) {
    where.push('(m.to_name LIKE ? OR m.to_email LIKE ? OR m.subject LIKE ? OR m.html LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status && status !== 'all') {
    where.push('m.status = ?');
    params.push(status);
  }
  if (campaignId) {
    where.push('m.campaign_id = ?');
    params.push(campaignId);
  }
  if (from) {
    where.push('COALESCE(m.sent_at, m.created_at) >= ?');
    params.push(from);
  }
  if (to) {
    where.push('COALESCE(m.sent_at, m.created_at) <= ?');
    params.push(`${to}T23:59:59.999Z`);
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

app.get('/api/messages', (req, res) => {
  const { clause, params } = historyQuery(req.query);
  const limit = asInt(req.query.limit, 25, 1, 200);
  const offset = asInt(req.query.offset, 0, 0, 1e9);
  const order = req.query.order === 'oldest' ? 'ASC' : 'DESC';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM messages m ${clause}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT m.*, c.name AS campaign_name
       FROM messages m
       LEFT JOIN campaigns c ON c.id = m.campaign_id
       ${clause}
       ORDER BY COALESCE(m.sent_at, m.created_at) ${order}, m.id ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  res.json({ total, limit, offset, messages: rows.map(messageRow) });
});

// NOTE: /api/messages/export must be declared before /api/messages/:id,
// otherwise Express matches "export" as an :id.
app.get('/api/messages/export', (req, res) => {
  const { clause, params } = historyQuery(req.query);
  const rows = db
    .prepare(
      `SELECT m.*, c.name AS campaign_name FROM messages m
       LEFT JOIN campaigns c ON c.id = m.campaign_id
       ${clause} ORDER BY COALESCE(m.sent_at, m.created_at) DESC LIMIT 5000`,
    )
    .all(...params)
    .map((row) => ({
      sent_at: row.sent_at ?? '',
      status: row.status,
      name: row.to_name,
      email: row.to_email,
      subject: row.subject,
      campaign: row.campaign_name ?? '',
      error: row.error ?? '',
    }));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sent-history.csv"');
  res.send(toCsv(rows, ['sent_at', 'status', 'name', 'email', 'subject', 'campaign', 'error']));
});

/**
 * Purge sent history.
 *
 * Body: { all?: boolean, status?: string, from?: string, to?: string, campaignId?: number, confirm?: string }
 *
 * Without a filter this deletes every message and campaign. With filters it
 * deletes only the matching messages, and drops campaigns that no longer have
 * any messages. History only — contacts and settings are never touched.
 */
app.post('/api/messages/clear', (req, res) => {
  const { all = false, status = '', from = '', to = '', campaignId = null, confirm = '' } = req.body ?? {};

  const filtered = Boolean(all !== true && (status || from || to || campaignId));
  // Deleting without a filter is destructive enough to require an explicit word.
  if (!filtered && String(confirm).toLowerCase() !== 'delete') {
    return res.status(400).json({
      error: 'This deletes every sent message. Repeat the request with confirm: "delete" to proceed.',
      requiresConfirm: true,
    });
  }

  const where = [];
  const params = [];

  if (filtered) {
    if (status && status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    if (campaignId) {
      where.push('campaign_id = ?');
      params.push(Number(campaignId));
    }
    if (from) {
      where.push('COALESCE(sent_at, created_at) >= ?');
      params.push(from);
    }
    if (to) {
      where.push('COALESCE(sent_at, created_at) <= ?');
      params.push(`${to}T23:59:59.999Z`);
    }
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let deletedMessages = 0;
  let deletedCampaigns = 0;

  db.exec('BEGIN');
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    db.prepare(`DELETE FROM messages ${clause}`).run(...params);
    deletedMessages = before - db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

    // Campaigns with no messages left are empty shells; remove them so the
    // history filters do not list campaigns that show nothing.
    const orphaned = db
      .prepare(
        `SELECT id FROM campaigns
         WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.campaign_id = campaigns.id)`,
      )
      .all();
    for (const row of orphaned) {
      db.prepare('DELETE FROM campaigns WHERE id = ?').run(row.id);
      deletedCampaigns += 1;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({
    ok: true,
    filtered,
    deletedMessages,
    deletedCampaigns,
    remaining: {
      messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
      campaigns: db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n,
    },
  });
});

app.get('/api/messages/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT m.*, c.name AS campaign_name
       FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.id = ?`,
    )
    .get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Message not found.' });
  const message = messageRow(row);
  res.json({ ...message, text: htmlToText(message.html) });
});

app.get('/api/stats', (_req, res) => {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM messages`,
    )
    .get();

  const recent = db
    .prepare(
      `SELECT substr(COALESCE(sent_at, created_at), 1, 10) AS day,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM messages
       WHERE COALESCE(sent_at, created_at) >= ?
       GROUP BY day ORDER BY day ASC`,
    )
    .all(new Date(Date.now() - 13 * 86_400_000).toISOString());

  const topRecipients = db
    .prepare(
      `SELECT to_email AS email, MAX(to_name) AS name, COUNT(*) AS count
       FROM messages WHERE status = 'sent'
       GROUP BY lower(to_email) ORDER BY count DESC LIMIT 5`,
    )
    .all();

  const campaigns = db
    .prepare(
      `SELECT id, name, subject, total, sent, failed, status, created_at, finished_at
       FROM campaigns ORDER BY id DESC LIMIT 20`,
    )
    .all();

  res.json({
    totals: {
      total: totals.total ?? 0,
      sent: totals.sent ?? 0,
      failed: totals.failed ?? 0,
      skipped: totals.skipped ?? 0,
    },
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    recent,
    topRecipients,
    campaigns,
  });
});

/* ------------------------------------------------------------------- statics */

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.path}` });
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err?.status ?? 500;
  if (status >= 500) console.error('[mailblast]', err);
  res.status(status).json({ error: err?.message ?? 'Unexpected server error.' });
});

export { PUBLIC_DIR, parseDelimited };
