import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db, nowIso, isSuppressed } from './db.js';
import { renderMessage } from './personalize.js';
import { resolveCampaignAttachments, linkAttachments } from './attachments.js';
import {
  buildMail,
  getTransport,
  persistCaptured,
  isTransportConfigured,
  describeTransport,
} from './mailer.js';

/**
 * Bulk sender.
 *
 * Messages are sent strictly **one at a time** (concurrency 1) so every
 * recipient gets an individually rendered message rather than a shared BCC
 * blast. Each attempt is written to the `messages` table immediately, which is
 * what powers the searchable sent history.
 */

const jobs = new Map();
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicJob(job) {
  if (!job) return null;
  const done = job.entries.filter((e) => e.status === 'sent' || e.status === 'failed' || e.status === 'skipped');
  const current = job.entries.find((e) => e.status === 'sending');
  return {
    id: job.id,
    campaignId: job.campaignId,
    status: job.status,
    transport: job.transportLabel,
    total: job.entries.length,
    processed: done.length,
    sent: job.entries.filter((e) => e.status === 'sent').length,
    failed: job.entries.filter((e) => e.status === 'failed').length,
    skipped: job.entries.filter((e) => e.status === 'skipped').length,
    percent: job.entries.length ? Math.round((done.length / job.entries.length) * 100) : 0,
    current: current ? { name: current.name, email: current.email } : null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    delayMs: job.delayMs,
    error: job.error ?? null,
    entries: job.entries.map((e, index) => ({
      index,
      contactId: e.contactId,
      messageId: e.messageId,
      name: e.name,
      email: e.email,
      status: e.status,
      error: e.error ?? null,
      sentAt: e.sentAt ?? null,
    })),
  };
}

export function listJobs() {
  return [...jobs.values()].map(publicJob).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getJob(id) {
  return publicJob(jobs.get(id));
}

export function subscribe(jobId, listener) {
  const event = `job:${jobId}`;
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

export function subscribeAll(listener) {
  emitter.on('any', listener);
  return () => emitter.off('any', listener);
}

function publish(job) {
  const payload = publicJob(job);
  emitter.emit(`job:${job.id}`, payload);
  emitter.emit('any', payload);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'running' || job.status === 'queued') {
    job.cancelRequested = true;
    job.status = 'cancelling';
    publish(job);
  }
  return publicJob(job);
}

/**
 * Start a bulk send.
 *
 * @param {object}   input
 * @param {string}   input.subject        Subject template.
 * @param {string}   input.html           HTML body template.
 * @param {Array}    input.recipients     [{ id?, name, email, company? }]
 * @param {boolean}  [input.personalize]  Render tokens per recipient.
 * @param {number}   [input.delayMs]      Pause between messages (politeness).
 * @param {string}   [input.campaignName]
 */
export function startSend(input) {
  const {
    subject = '',
    html = '',
    recipients = [],
    personalize = true,
    delayMs = 250,
    campaignName = '',
    fromName = '',
    replyTo = '',
    attachmentIds = [],
  } = input;

  if (!recipients.length) {
    throw Object.assign(new Error('No recipients selected.'), { status: 400 });
  }
  if (!String(subject).trim() && !String(html).trim()) {
    throw Object.assign(new Error('Add a subject or an HTML body before sending.'), { status: 400 });
  }
  if (!isTransportConfigured()) {
    throw Object.assign(
      new Error('SMTP is not configured yet. Open Settings to add your mail server, or switch on capture mode to test.'),
      { status: 400 },
    );
  }

  const ts = nowIso();
  const campaign = db
    .prepare(
      `INSERT INTO campaigns (name, subject, html, from_name, reply_to, personalize, total, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', ?)`,
    )
    .run(
      String(campaignName).trim() || String(subject).trim().slice(0, 80) || 'Untitled campaign',
      String(subject),
      String(html),
      String(fromName),
      String(replyTo),
      personalize ? 1 : 0,
      recipients.length,
      ts,
    );

  const campaignId = Number(campaign.lastInsertRowid);
  const transportLabel = describeTransport().label;

  const entries = recipients.map((r) => ({
    contactId: r.id ?? null,
    name: String(r.name ?? '').trim(),
    email: String(r.email ?? '').trim(),
    company: String(r.company ?? '').trim(),
    status: 'queued',
    messageId: null,
    error: null,
    sentAt: null,
  }));

  const job = {
    id: randomUUID(),
    campaignId,
    entries,
    status: 'queued',
    startedAt: ts,
    finishedAt: null,
    delayMs: Math.max(0, Number(delayMs) || 0),
    transportLabel,
    personalize,
    subject: String(subject),
    html: String(html),
    replyTo: String(replyTo),
    cancelRequested: false,
    error: null,
    attachmentIds: Array.isArray(attachmentIds) ? attachmentIds.map(Number).filter(Number.isFinite) : [],
  };

  // Remember which files this campaign carried, so the history can show them.
  if (job.attachmentIds.length) {
    linkAttachments(campaignId, job.attachmentIds);
  }

  jobs.set(job.id, job);
  publish(job);
  run(job).catch((err) => {
    job.status = 'failed';
    job.error = err?.message ?? String(err);
    job.finishedAt = nowIso();
    publish(job);
  });

  return publicJob(job);
}

async function run(job) {
  // Building the transport up-front fails fast on bad SMTP settings, instead of
  // failing once per recipient.
  const active = getTransport();
  job.status = 'running';
  publish(job);

  // Attachments are shared by every message in the campaign, so read them once.
  let sharedAttachments = [];
  if (job.attachmentIds.length) {
    const resolved = resolveCampaignAttachments(job.campaignId);
    sharedAttachments = resolved.attachments;
    if (resolved.missing.length) {
      console.warn(`[mailblast] missing attachment file(s): ${resolved.missing.join(', ')}`);
    }
  }

  for (const entry of job.entries) {
    if (job.cancelRequested) {
      entry.status = 'skipped';
      entry.error = 'Cancelled before send';
      continue;
    }

    if (isSuppressed(entry.email)) {
      entry.status = 'skipped';
      entry.error = 'On suppression list';
      const info = db
        .prepare(
          `INSERT INTO messages (campaign_id, contact_id, to_name, to_email, subject, html, status, error, transport, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)`,
        )
        .run(
          job.campaignId,
          entry.contactId,
          entry.name,
          entry.email,
          job.subject,
          job.html,
          'Address is on the suppression list',
          active.kind,
          nowIso(),
        );
      entry.messageId = Number(info.lastInsertRowid);
      publish(job);
      continue;
    }

    entry.status = 'sending';
    publish(job);

    let rendered;
    let mail;
    try {
      rendered = renderMessage({
        subject: job.subject,
        html: job.html,
        contact: entry,
        personalize: job.personalize,
      });
      mail = buildMail({
        to: entry.email,
        toName: job.personalize ? entry.name : '',
        subject: rendered.subject,
        html: rendered.html,
        cfg: active.cfg,
        attachments: sharedAttachments,
      });
    } catch (err) {
      entry.status = 'failed';
      entry.error = err?.message ?? String(err);
      const info = db
        .prepare(
          `INSERT INTO messages (campaign_id, contact_id, to_name, to_email, subject, html, status, error, transport, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
        )
        .run(
          job.campaignId,
          entry.contactId,
          entry.name,
          entry.email,
          job.subject,
          job.html,
          entry.error,
          active.kind,
          nowIso(),
        );
      entry.messageId = Number(info.lastInsertRowid);
      publish(job);
      continue;
    }

    const created = nowIso();
    const inserted = db
      .prepare(
        `INSERT INTO messages (campaign_id, contact_id, to_name, to_email, subject, html, status, transport, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      )
      .run(
        job.campaignId,
        entry.contactId,
        entry.name,
        entry.email,
        rendered.subject,
        rendered.html,
        active.kind,
        created,
      );
    entry.messageId = Number(inserted.lastInsertRowid);

    try {
      const info = await active.transport.sendMail(mail);
      if (active.kind === 'capture') persistCaptured(info, mail);

      entry.status = 'sent';
      entry.sentAt = nowIso();
      db.prepare(
        `UPDATE messages SET status = 'sent', sent_at = ?, response = ? WHERE id = ?`,
      ).run(entry.sentAt, String(info.response ?? 'captured'), entry.messageId);
    } catch (err) {
      entry.status = 'failed';
      entry.error = err?.message ?? String(err);
      db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).run(
        entry.error,
        entry.messageId,
      );
    }

    publish(job);

    if (job.delayMs > 0) await sleep(job.delayMs);
  }

  const sent = job.entries.filter((e) => e.status === 'sent').length;
  const failed = job.entries.filter((e) => e.status === 'failed').length;

  job.status = job.cancelRequested ? 'cancelled' : failed && !sent ? 'failed' : 'completed';
  job.finishedAt = nowIso();

  db.prepare(
    `UPDATE campaigns SET sent = ?, failed = ?, status = ?, finished_at = ? WHERE id = ?`,
  ).run(sent, failed, job.status, job.finishedAt, job.campaignId);

  publish(job);
}

/** Send a single standalone message (used by "send test" and "resend"). */
export async function sendSingle({ to, toName = '', subject, html, contactId = null, campaignId = null }) {
  if (!isTransportConfigured()) {
    throw Object.assign(new Error('SMTP is not configured yet.'), { status: 400 });
  }
  const active = getTransport();
  const rendered = renderMessage({
    subject,
    html,
    contact: { name: toName, email: to },
    personalize: true,
  });
  const mail = buildMail({
    to,
    toName,
    subject: rendered.subject,
    html: rendered.html,
    cfg: active.cfg,
  });

  const inserted = db
    .prepare(
      `INSERT INTO messages (campaign_id, contact_id, to_name, to_email, subject, html, status, transport, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
    )
    .run(campaignId, contactId, toName, to, rendered.subject, rendered.html, active.kind, nowIso());

  const id = Number(inserted.lastInsertRowid);
  try {
    const info = await active.transport.sendMail(mail);
    if (active.kind === 'capture') persistCaptured(info, mail);
    const sentAt = nowIso();
    db.prepare(`UPDATE messages SET status = 'sent', sent_at = ?, response = ? WHERE id = ?`).run(
      sentAt,
      String(info.response ?? 'captured'),
      id,
    );
    return { ok: true, id, messageId: info.messageId ?? null, status: 'sent', sentAt };
  } catch (err) {
    const message = err?.message ?? String(err);
    db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).run(message, id);
    return { ok: false, id, status: 'failed', error: message };
  }
}
