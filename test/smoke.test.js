/**
 * End-to-end smoke test.
 *
 * Boots a throwaway server (its own data directory and port), then drives the
 * real HTTP API: import contacts from CSV, send a personalized bulk campaign in
 * capture mode, and search the sent history.
 *
 * Run with:  node test/smoke.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT) || 4599;
const BASE = `http://127.0.0.1:${PORT}`;

// Point the server at a scratch data directory before importing it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailblast-test-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = String(PORT);

const { app } = await import('../server/routes.js');
const { parseContacts, toCsv } = await import('../server/csv.js');
const { renderString, buildContext, htmlToText } = await import('../server/personalize.js');

const server = app.listen(PORT);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

const api = async (routePath, options = {}) => {
  const response = await fetch(`${BASE}${routePath}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${payload?.error ?? text}`);
  }
  return payload;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let job = await api(`/api/jobs/${id}`);
  while ((job.status === 'running' || job.status === 'queued' || job.status === 'cancelling') && Date.now() < deadline) {
    await sleep(120);
    job = await api(`/api/jobs/${id}`);
  }
  return job;
}

console.log('\nMailBlast smoke test\n');

/* ------------------------------------------------------------ unit behaviour */

await test('CSV parser reads a headered file in any column order', () => {
  const csv = 'Email,Full Name,Company\nada@example.com,Ada Lovelace,Analytical Engines\ngrace@example.com,Grace Hopper,Navy\n';
  const { contacts, hadHeader } = parseContacts(csv);
  assert.equal(hadHeader, true);
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].name, 'Ada Lovelace');
  assert.equal(contacts[1].email, 'grace@example.com');
});

await test('CSV parser infers columns without a header and skips bad rows', () => {
  const csv = 'Ada Lovelace,ada@example.com\nGrace Hopper,grace@example.com\nBroken Row,not-an-email\n';
  const { contacts, skipped } = parseContacts(csv);
  assert.equal(contacts.length, 2);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /Invalid email/);
});

await test('CSV parser handles quoted fields containing commas and newlines', () => {
  const csv = 'name,email,company\n"Lovelace, Ada",ada@example.com,"Engines, Ltd"\n"Multi\nLine",ml@example.com,Acme\n';
  const { contacts } = parseContacts(csv);
  assert.equal(contacts.length, 2);
  assert.equal(contacts[0].name, 'Lovelace, Ada');
  assert.equal(contacts[0].company, 'Engines, Ltd');
  assert.equal(contacts[1].name, 'Multi\nLine');
});

await test('personalization renders first/last name, company and date', () => {
  const context = buildContext({ name: 'Ada Lovelace', email: 'ada@example.com', company: 'Engines' });
  assert.equal(renderString('Hi {{first_name}} from {{company}}', context), 'Hi Ada from Engines');
  assert.equal(renderString('{{ last_name }}', context), 'Lovelace');
  assert.equal(renderString('Hello {{unknown}}', context), 'Hello {{unknown}}');
});

await test('HTML converts to a readable plain-text alternative', () => {
  const text = htmlToText('<h1>Hi</h1><p>Read <a href="https://x.test">the docs</a>.</p><ul><li>One</li><li>Two</li></ul>');
  assert.match(text, /Hi/);
  // A link with visible text keeps just the text, with no stray space before the period.
  assert.match(text, /Read the docs\./);
  // A link with no visible text falls back to its URL in angle brackets.
  assert.match(htmlToText('<p>Bare <a href="https://b.test"></a></p>'), /Bare https:\/\/b\.test/);
  assert.match(text, /• One/);
});

await test('toCsv quotes values that contain separators', () => {
  const csv = toCsv([{ name: 'Lovelace, Ada', email: 'a@b.co' }], ['name', 'email']);
  assert.match(csv, /"Lovelace, Ada"/);
});

/* ------------------------------------------------------------------- http api */

await test('capture mode can be enabled without a real mail server', async () => {
  const result = await api('/api/settings', {
    method: 'PUT',
    body: {
      smtp: {
        captureMode: true,
        fromName: 'MailBlast Test',
        fromEmail: 'hello@example.com',
        replyTo: 'replies@example.com',
      },
    },
  });
  assert.equal(result.smtp.captureMode, true);
  assert.equal(result.configured, true);
  assert.equal(result.smtp.password, undefined, 'password must never be returned to the client');
});

await test('contacts import creates, then updates on a second import', async () => {
  const csv = [
    'Name,Email,Company,Tags',
    'Ada Lovelace,ada@example.com,Analytical Engines,"vip;newsletter"',
    'Grace Hopper,grace@example.com,Navy,vip',
    'Alan Turing,alan@example.com,NatWest,',
  ].join('\n');

  const first = await api('/api/contacts/import', { method: 'POST', body: { csv, tags: ['2026'] } });
  assert.equal(first.created, 3);
  assert.equal(first.updated, 0);

  const second = await api('/api/contacts/import', {
    method: 'POST',
    body: { csv: 'Name,Email\nAda Lovelace,ada@example.com\n', tags: ['updated'] },
  });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);

  const list = await api('/api/contacts?limit=10');
  assert.equal(list.total, 3);
  const ada = list.contacts.find((c) => c.email === 'ada@example.com');
  assert.ok(ada.tags.includes('2026'));
  assert.ok(ada.tags.includes('updated'));
});

await test('duplicate emails inside one file are collapsed', async () => {
  const result = await api('/api/contacts/import', {
    method: 'POST',
    body: { csv: 'Name,Email\nDup One,dup@example.com\nDup Two,dup@example.com\n' },
  });
  assert.equal(result.detected, 2);
  assert.equal(result.unique, 1);
  assert.equal(result.duplicatesInFile, 1);
});

await test('contact search matches name and email', async () => {
  const byName = await api('/api/contacts?q=grace');
  assert.equal(byName.total, 1);
  const byEmail = await api('/api/contacts?q=alan@');
  assert.equal(byEmail.total, 1);
});

await test('preview personalizes subject and body for a sample contact', async () => {
  const result = await api('/api/preview', {
    method: 'POST',
    body: { subject: 'Hello {{first_name}}', html: '<p>{{name}} at {{company}}</p>', contact: { name: 'Ada Lovelace', company: 'Engines' } },
  });
  assert.equal(result.subject, 'Hello Ada');
  assert.match(result.html, /Ada Lovelace at Engines/);
  assert.deepEqual(result.tokens.sort(), ['company', 'first_name', 'name']);
});

await test('bulk send queues a personalized message per contact', async () => {
  const { contacts } = await api('/api/contacts?limit=100');
  const recipients = contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, company: c.company }));

  const started = await api('/api/send', {
    method: 'POST',
    body: {
      subject: 'Hi {{first_name}}, a note for {{company}}',
      html: '<p>Hello {{name}}, this is personalized.</p>',
      recipients,
      personalize: true,
      delayMs: 0,
      campaignName: 'Smoke test campaign',
    },
  });

  assert.equal(started.job.total, recipients.length);
  assert.ok(started.job.entries.length === recipients.length);

  const job = await waitForJob(started.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.sent, recipients.length);
  assert.equal(job.failed, 0);
});

await test('each delivered message is individually rendered', async () => {
  const history = await api('/api/messages?q=personalized&limit=50');
  assert.equal(history.total, 4);
  const ada = history.messages.find((m) => m.email === 'ada@example.com');
  assert.match(ada.html, /Hello Ada Lovelace/);
  assert.match(ada.subject, /Hi Ada, a note for Analytical Engines/);
  const grace = history.messages.find((m) => m.email === 'grace@example.com');
  assert.match(grace.html, /Hello Grace Hopper/);
});

await test('sent history is searchable by recipient, subject and body', async () => {
  const byRecipient = await api('/api/messages?q=grace@example.com');
  assert.equal(byRecipient.total, 1);
  const bySubject = await api('/api/messages?q=note for');
  assert.equal(bySubject.total, 4);
  const byBody = await api('/api/messages?q=personalized');
  assert.equal(byBody.total, 4);
  const byStatus = await api('/api/messages?status=failed');
  assert.equal(byStatus.total, 0);
});

await test('history pagination reports the full total', async () => {
  const page = await api('/api/messages?limit=2&offset=0');
  assert.equal(page.messages.length, 2);
  assert.equal(page.total, 4);
  const next = await api('/api/messages?limit=2&offset=2');
  assert.equal(next.messages.length, 2);
  assert.notEqual(page.messages[0].id, next.messages[0].id);
});

await test('message detail exposes the plain-text alternative', async () => {
  const list = await api('/api/messages?limit=1');
  const detail = await api(`/api/messages/${list.messages[0].id}`);
  assert.match(detail.text, /personalized/);
  assert.ok(detail.sentAt);
});

await test('capture mode wrote a real .eml file to the outbox', () => {
  const outbox = path.join(dataDir, 'outbox');
  const files = fs.readdirSync(outbox);
  assert.equal(files.length, 4);
  const raw = fs.readFileSync(path.join(outbox, files[0]), 'utf8');
  assert.match(raw, /Subject:/);
  assert.match(raw, /Hello (Ada|Grace|Alan)/);
});

await test('a single test message can be sent on demand', async () => {
  const result = await api('/api/send/test', {
    method: 'POST',
    body: { to: 'tester@example.com', subject: 'Test', html: '<p>test body</p>' },
  });
  assert.equal(result.ok, true);
  const history = await api('/api/messages?q=tester@example.com');
  assert.equal(history.total, 1);
});

await test('history CSV export walks the same filters', async () => {
  const response = await fetch(`${BASE}/api/messages/export?q=grace`);
  const csv = await response.text();
  assert.match(csv, /grace@example\.com/);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2, 'header + one matching row');
});

await test('stats endpoint aggregates totals and campaigns', async () => {
  const stats = await api('/api/stats');
  assert.equal(stats.totals.total, 5);
  assert.equal(stats.totals.sent, 5);
  assert.ok(stats.campaigns.length >= 1);
  assert.equal(stats.contacts, 4);
});

await test('sending with no recipients is rejected with a clear message', async () => {
  await assert.rejects(
    () => api('/api/send', { method: 'POST', body: { subject: 'x', html: '<p>x</p>', recipients: [] } }),
    /No valid recipient/i,
  );
});

await test('production sender can be switched back on and is remembered', async () => {
  const result = await api('/api/settings', {
    method: 'PUT',
    body: { smtp: { captureMode: false, host: 'smtp.example.com', port: 587, user: 'me@example.com', password: 'secret' } },
  });
  assert.equal(result.smtp.captureMode, false);
  assert.equal(result.smtp.hasPassword, true);
  assert.equal(result.smtp.password, undefined);
});

/* ------------------------------------------------ client/server filter parity */

await test('client history params match what the server filter expects', async () => {
  const { historyParams, pageNumber, pageCount, visibleRange } = await import('../public/js/views/query.js');

  const params = historyParams({
    q: 'ada@example.com',
    status: 'failed',
    campaignId: '7',
    from: '2026-01-01',
    to: '2026-01-31',
    order: 'oldest',
    limit: 25,
    offset: 25,
  });

  assert.equal(params.get('q'), 'ada@example.com');
  assert.equal(params.get('status'), 'failed');
  assert.equal(params.get('campaignId'), '7');
  assert.equal(params.get('from'), '2026-01-01T00:00:00.000Z');
  assert.equal(params.get('to'), '2026-01-31');
  assert.equal(params.get('order'), 'oldest');

  // The same query string must drive a real request without erroring.
  const response = await fetch(`${BASE}/api/messages?${params}`);
  assert.equal(response.status, 200);

  assert.equal(pageNumber(0, 25), 1);
  assert.equal(pageNumber(25, 25), 2);
  assert.equal(pageCount(0, 25), 1);
  assert.equal(pageCount(26, 25), 2);
  assert.deepEqual(visibleRange(0, 25, 0), { first: 0, last: 0 });
  assert.deepEqual(visibleRange(50, 25, 120), { first: 51, last: 75 });
});

await test('client contact params match the server contacts filter', async () => {
  const { contactParams } = await import('../public/js/views/query.js');
  const params = contactParams({ q: 'grace', tag: 'vip', sort: 'created', limit: 10, offset: 0 });
  assert.equal(params.get('sort'), 'created');
  assert.equal(params.get('tag'), 'vip');

  const response = await fetch(`${BASE}/api/contacts?${params}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.contacts.length, 1);
  assert.equal(payload.contacts[0].email, 'grace@example.com');
});

/* -------------------------------------------------------------- clear history */

await test('clearing all history requires an explicit confirmation', async () => {
  await assert.rejects(
    () => api('/api/messages/clear', { method: 'POST', body: { all: true } }),
    /confirm/i,
    'a full purge without confirmation must be refused',
  );

  // Nothing should have been removed by the refused call.
  const history = await api('/api/messages?limit=1');
  assert.ok(history.total > 0, 'the refused purge must not delete anything');
});

await test('clearing with a filter removes only matching messages', async () => {
  const before = await api('/api/messages?limit=1');
  const failed = await api('/api/messages?status=failed&limit=1');

  // Everything currently recorded is 'sent', so filtering on failed is a no-op.
  const result = await api('/api/messages/clear', {
    method: 'POST',
    body: { status: 'failed' },
  });

  assert.equal(result.filtered, true, 'a filtered purge should be reported as filtered');
  const after = await api('/api/messages?limit=1');
  assert.equal(after.total, before.total, 'a non-matching filter must delete nothing');
  assert.equal(result.deletedMessages, 0);
  assert.equal(failed.total, 0);
});

await test('a filtered purge by campaign removes that campaign only', async () => {
  const before = await api('/api/messages?limit=1');
  const stats = await api('/api/stats');
  const campaign = stats.campaigns.find((c) => c.total > 0);
  assert.ok(campaign, 'expected at least one campaign with messages');

  const result = await api('/api/messages/clear', {
    method: 'POST',
    body: { campaignId: campaign.id },
  });

  assert.equal(result.deletedMessages, campaign.total, 'should delete exactly that campaign');
  assert.equal(result.deletedCampaigns, 1, 'the now-empty campaign should be removed too');

  const after = await api('/api/messages?limit=1');
  assert.equal(after.total, before.total - campaign.total);
  const remaining = await api(`/api/messages?campaignId=${campaign.id}&limit=1`);
  assert.equal(remaining.total, 0, 'no messages should remain for the purged campaign');
});

await test('a confirmed full purge empties the history and leaves contacts alone', async () => {
  const contactsBefore = (await api('/api/contacts?limit=1')).total;

  const result = await api('/api/messages/clear', {
    method: 'POST',
    body: { all: true, confirm: 'delete' },
  });

  assert.ok(result.deletedMessages > 0, 'should report how many were removed');
  assert.equal(result.remaining.messages, 0, 'no messages should remain');
  assert.equal(result.remaining.campaigns, 0, 'no campaigns should remain');

  const history = await api('/api/messages?limit=5');
  assert.equal(history.total, 0);

  const stats = await api('/api/stats');
  assert.equal(stats.totals.total, 0);
  assert.equal(stats.totals.sent, 0);
  assert.deepEqual(stats.campaigns, [], 'campaign list should be empty');

  // History is independent of the address book.
  const contactsAfter = (await api('/api/contacts?limit=1')).total;
  assert.equal(contactsAfter, contactsBefore, 'contacts must not be touched');
});

await test('history is empty but a new send still records normally afterwards', async () => {
  // An earlier test switched the transport to OAuth SMTP; put capture mode back
  // so this send stays offline, like the rest of this suite.
  await api('/api/settings', {
    method: 'PUT',
    body: { smtp: { captureMode: true, authType: 'password', host: '', user: '' } },
  });

  const started = await api('/api/send', {
    method: 'POST',
    body: {
      subject: 'After the purge {{first_name}}',
      html: '<p>Still working</p>',
      recipients: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
      personalize: true,
      delayMs: 0,
    },
  });
  const job = await waitForJob(started.job.id);
  assert.equal(job.sent, 1, `expected the send to succeed, got status=${job.status} failed=${job.failed}`);

  const history = await api('/api/messages?limit=5');
  assert.equal(history.total, 1, 'the new message should be recorded');
});

/* ------------------------------------------------------------------- teardown */

server.close();
await sleep(200);

console.log(`\n${passed} passed, ${failed} failed\n`);
console.log(`test data: ${dataDir}\n`);

process.exit(failed === 0 ? 0 : 1);
