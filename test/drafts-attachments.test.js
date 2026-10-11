/**
 * Drafts and attachments tests.
 *
 * Boots a real server on a scratch database and drives the multipart upload and
 * drafts endpoints over HTTP, then inspects a captured message to prove the
 * attachment actually reached the MIME output.
 *
 * Run with:  node test/drafts-attachments.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailblast-da-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '4622';

const { app } = await import('../server/routes.js');
const {
  sanitizeFilename,
  validateUpload,
  MAX_FILE_BYTES,
} = await import('../server/attachments.js');

const BASE = 'http://127.0.0.1:4622';
const server = app.listen(4622);

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

async function api(routePath, { method = 'GET', body, raw } = {}) {
  const options = { method, headers: {} };
  if (raw) {
    options.body = raw;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${routePath}`, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, ok: response.ok, payload };
}

/** Upload one buffer as multipart/form-data. */
async function upload(filename, contents, type = 'text/plain') {
  const form = new FormData();
  form.append('files', new Blob([contents], { type }), filename);
  const response = await fetch(`${BASE}/api/attachments`, { method: 'POST', body: form });
  const payload = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, payload };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let { payload: job } = await api(`/api/jobs/${id}`);
  while (['running', 'queued', 'cancelling'].includes(job.status) && Date.now() < deadline) {
    await sleep(120);
    ({ payload: job } = await api(`/api/jobs/${id}`));
  }
  return job;
}

console.log('\nMailBlast drafts & attachments\n');

// A fresh database has no sender identity, and the send path requires one.
await api('/api/settings', {
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

/* ---------------------------------------------------------------- filename safety */

await test('filenames are stripped of anything path-like', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Windows\\system32\\evil.txt'), 'evil.txt');
  assert.equal(sanitizeFilename('/absolute/path/report.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('..'), 'attachment');
  assert.equal(sanitizeFilename(''), 'attachment');
  assert.equal(sanitizeFilename('....hidden'), 'hidden');
});

await test('control characters and quote-breaking characters are removed', () => {
  assert.equal(sanitizeFilename('in\r\njected.txt'), 'injected.txt');
  assert.equal(sanitizeFilename('bad"name<>.txt'), 'badname.txt');
  assert.ok(!sanitizeFilename('a\u0000b.txt').includes('\u0000'));
});

await test('long filenames are capped', () => {
  const long = `${'x'.repeat(400)}.pdf`;
  assert.ok(sanitizeFilename(long).length <= 180);
});

await test('executable types are refused before anything is written', () => {
  for (const name of ['virus.exe', 'script.bat', 'run.CMD', 'evil.ps1', 'thing.js', 'x.msi']) {
    const problem = validateUpload({ originalname: name, size: 10 });
    assert.ok(problem, `${name} should be refused`);
    assert.match(problem, /executable file type/);
  }
});

await test('ordinary document types are allowed', () => {
  for (const name of ['report.pdf', 'photo.png', 'sheet.xlsx', 'notes.txt', 'deck.pptx']) {
    assert.equal(validateUpload({ originalname: name, size: 1024 }), null, `${name} should be allowed`);
  }
});

await test('an oversized file is refused with a readable message', () => {
  const problem = validateUpload({ originalname: 'big.zip', size: MAX_FILE_BYTES + 1 });
  assert.ok(problem);
  assert.match(problem, /larger than/);
});

/* --------------------------------------------------------------------- uploads */

await test('uploading a file stores it and returns its metadata', async () => {
  const result = await upload('notes.txt', 'hello attachments');
  assert.equal(result.status, 201);
  assert.equal(result.payload.attachments.length, 1);

  const file = result.payload.attachments[0];
  assert.equal(file.filename, 'notes.txt');
  assert.equal(file.size, 17);
  assert.equal(file.contentType, 'text/plain');
  assert.ok(file.id > 0);
});

await test('the stored file is not reachable by its original name', async () => {
  const { payload } = await api('/api/attachments');
  assert.ok(payload.attachments.length > 0);

  // The bytes live under a randomised stored name inside the attachments dir.
  const dir = path.join(dataDir, 'attachments');
  const stored = fs.readdirSync(dir);
  assert.ok(stored.length > 0, 'a file should exist on disk');
  assert.ok(
    stored.every((name) => !name.startsWith('..')),
    'no stored file may escape the directory via its name',
  );
  assert.ok(
    stored.some((name) => name.endsWith('__notes.txt')),
    'the stored name should keep a readable suffix',
  );
});

await test('an executable upload is rejected with a clear error', async () => {
  const result = await upload('malware.exe', 'MZ');
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /executable file type/);
});

await test('a failed upload does not leave a file on disk', async () => {
  const dir = path.join(dataDir, 'attachments');
  const before = fs.readdirSync(dir).length;
  await upload('another.exe', 'MZ');
  assert.equal(fs.readdirSync(dir).length, before, 'nothing should be written for a rejected file');
});

await test('uploading with no file is rejected', async () => {
  const form = new FormData();
  form.append('notafile', 'x');
  const response = await fetch(`${BASE}/api/attachments`, { method: 'POST', body: form });
  assert.equal(response.status, 400);
});

await test('an attachment can be downloaded by id', async () => {
  const { payload } = await upload('download-me.txt', 'the contents');
  const id = payload.attachments[0].id;

  const response = await fetch(`${BASE}/api/attachments/${id}/download`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'the contents');
  assert.match(response.headers.get('content-disposition') ?? '', /download-me\.txt/);
});

await test('downloading an unknown id is a 404, not a crash', async () => {
  const { status } = await api('/api/attachments/999999/download');
  assert.equal(status, 404);
});

await test('a deleted attachment file disappears from disk', async () => {
  const { payload } = await upload('temp.txt', 'temporary');
  const id = payload.attachments[0].id;
  const dir = path.join(dataDir, 'attachments');
  const before = fs.readdirSync(dir).length;

  const { status } = await api(`/api/attachments/${id}`, { method: 'DELETE' });
  assert.equal(status, 200);
  assert.equal(fs.readdirSync(dir).length, before - 1, 'the file should be removed from disk');
});

/* ---------------------------------------------------------------------- drafts */

await test('a draft saves everything needed to resume writing', async () => {
  const { status, payload } = await api('/api/drafts', {
    method: 'POST',
    body: {
      name: 'October update',
      subject: 'Hi {{first_name}}',
      html: '<p>Hello there</p>',
      fromName: 'Manjoor',
      personalize: true,
      delayMs: 400,
      recipientMode: 'tags',
      tags: ['vip', 'news'],
      manual: '',
      attachmentIds: [],
    },
  });

  assert.equal(status, 201);
  assert.equal(payload.draft.name, 'October update');
  assert.equal(payload.draft.delayMs, 400);
  assert.equal(payload.draft.recipientMode, 'tags');
  assert.deepEqual(payload.draft.tags, ['vip', 'news']);
  assert.equal(payload.draft.personalize, true);
});

await test('a draft is sanitised when saved', async () => {
  const { payload } = await api('/api/drafts', {
    method: 'POST',
    body: { subject: 'x', html: '<p>ok</p><script>alert(1)</script><img src=x onerror="alert(1)">' },
  });

  assert.ok(!payload.draft.html.includes('<script'), 'scripts must not survive into a draft');
  assert.ok(!/onerror/i.test(payload.draft.html), 'event handlers must not survive');
  assert.match(payload.draft.html, /ok/);
});

await test('an untitled draft is named from its subject', async () => {
  const { payload } = await api('/api/drafts', {
    method: 'POST',
    body: { name: '', subject: 'Autumn newsletter', html: '<p>x</p>' },
  });
  assert.equal(payload.draft.name, 'Autumn newsletter');
});

await test('a draft with no subject is named from its body text', async () => {
  const { payload } = await api('/api/drafts', {
    method: 'POST',
    body: { name: '', subject: '', html: '<p>Just a quick thought about things</p>' },
  });
  assert.equal(payload.draft.name, 'Just a quick thought about things');
});

await test('drafts are listed newest-updated first', async () => {
  const first = await api('/api/drafts', { method: 'POST', body: { name: 'Older draft', html: '<p>a</p>' } });
  await sleep(15);
  const second = await api('/api/drafts', { method: 'POST', body: { name: 'Newer draft', html: '<p>b</p>' } });

  // Touch the older one so it becomes the most recently updated.
  await sleep(15);
  await api(`/api/drafts/${first.payload.draft.id}`, {
    method: 'PUT',
    body: { name: 'Older draft', html: '<p>a edited</p>' },
  });

  const { payload } = await api('/api/drafts');
  assert.equal(payload.drafts[0].id, first.payload.draft.id, 'the last-edited draft should come first');
  assert.ok(payload.total >= 2);
  assert.ok(payload.drafts.some((d) => d.id === second.payload.draft.id));
});

await test('drafts can be searched by name, subject and body', async () => {
  await api('/api/drafts', { method: 'POST', body: { name: 'Searchable', subject: 'Zebra crossing', html: '<p>unique-body-word</p>' } });

  const byName = await api('/api/drafts?q=Searchable');
  assert.ok(byName.payload.total >= 1);
  const bySubject = await api('/api/drafts?q=Zebra');
  assert.ok(bySubject.payload.total >= 1);
  const byBody = await api('/api/drafts?q=unique-body-word');
  assert.ok(byBody.payload.total >= 1);
});

await test('a draft can be updated in place', async () => {
  const created = await api('/api/drafts', { method: 'POST', body: { name: 'Editable', html: '<p>one</p>' } });
  const id = created.payload.draft.id;

  const updated = await api(`/api/drafts/${id}`, {
    method: 'PUT',
    body: { name: 'Edited name', subject: 'Edited subject', html: '<p>two</p>', delayMs: 999 },
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.payload.draft.name, 'Edited name');
  assert.equal(updated.payload.draft.html, '<p>two</p>');
  assert.equal(updated.payload.draft.delayMs, 999);
  assert.equal(updated.payload.draft.id, id, 'updating must not create a new draft');
});

await test('updating a missing draft is a 404', async () => {
  const { status } = await api('/api/drafts/999999', { method: 'PUT', body: { html: '<p>x</p>' } });
  assert.equal(status, 404);
});

await test('a draft can be duplicated', async () => {
  const created = await api('/api/drafts', { method: 'POST', body: { name: 'Original', subject: 'S', html: '<p>body</p>' } });
  const copy = await api(`/api/drafts/${created.payload.draft.id}/duplicate`, { method: 'POST' });

  assert.equal(copy.status, 201);
  assert.notEqual(copy.payload.draft.id, created.payload.draft.id, 'a copy needs its own id');
  assert.match(copy.payload.draft.name, /\(copy\)$/);
  assert.equal(copy.payload.draft.subject, 'S');
  assert.equal(copy.payload.draft.html, '<p>body</p>');
});

await test('a draft can be deleted', async () => {
  const created = await api('/api/drafts', { method: 'POST', body: { name: 'Doomed', html: '<p>x</p>' } });
  const id = created.payload.draft.id;

  assert.equal((await api(`/api/drafts/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/drafts/${id}`)).status, 404);
});

await test('a draft keeps its attachments across a save and reload', async () => {
  const file = await upload('kept.txt', 'attached to a draft');
  const id = file.payload.attachments[0].id;

  const created = await api('/api/drafts', {
    method: 'POST',
    body: { name: 'With attachment', html: '<p>x</p>', attachmentIds: [id] },
  });

  assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.payload)}`);
  assert.deepEqual(created.payload.draft.attachmentIds, [id]);

  const reloaded = await api(`/api/drafts/${created.payload.draft.id}`);
  assert.equal(reloaded.status, 200, `reload failed: ${JSON.stringify(reloaded.payload)}`);
  assert.deepEqual(reloaded.payload.attachmentIds, [id], 'attachment ids must survive a round trip');
});

/* ------------------------------------------------------------- sending with files */

await test('a campaign carries its attachment into the MIME output', async () => {
  await api('/api/settings', { method: 'PUT', body: { smtp: { captureMode: true } } });

  const file = await upload('report.txt', 'REPORT-CONTENT-12345');
  const attachmentId = file.payload.attachments[0].id;

  const sent = await api('/api/send', {
    method: 'POST',
    body: {
      subject: 'With a file {{first_name}}',
      html: '<p>See attached.</p>',
      recipients: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
      personalize: true,
      delayMs: 0,
      attachmentIds: [attachmentId],
    },
  });

  assert.equal(sent.status, 202);
  assert.equal(sent.payload.attachmentCount, 1);
  assert.ok(sent.payload.attachmentBytes >= 19);

  const job = await waitForJob(sent.payload.job.id);
  assert.equal(job.status, 'completed');
  assert.equal(job.sent, 1);

  const outbox = path.join(dataDir, 'outbox');
  const newest = fs
    .readdirSync(outbox)
    .map((name) => ({ name, time: fs.statSync(path.join(outbox, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)[0];
  const raw = fs.readFileSync(path.join(outbox, newest.name), 'utf8');

  assert.match(raw, /multipart\/mixed/i, 'an attachment requires multipart/mixed');
  assert.match(raw, /Content-Disposition: attachment/i);
  assert.match(raw, /report\.txt/, 'the original filename must appear');

  // Decode the attachment payload and confirm the bytes survived intact.
  const base64Block = raw.split(/Content-Transfer-Encoding: base64/i)[1] ?? '';
  const body = base64Block.split(/\r?\n\r?\n/)[1]?.split(/\r?\n--/)[0] ?? '';
  assert.match(Buffer.from(body, 'base64').toString('utf8'), /REPORT-CONTENT-12345/);
});

await test('sending with a missing attachment id still succeeds, without the file', async () => {
  const sent = await api('/api/send', {
    method: 'POST',
    body: {
      subject: 'Missing file',
      html: '<p>x</p>',
      recipients: [{ name: '', email: 'ada@example.com' }],
      delayMs: 0,
      attachmentIds: [999999],
    },
  });

  assert.equal(sent.status, 202);
  assert.equal(sent.payload.attachmentCount, 0, 'a vanished file is dropped rather than failing the send');

  const job = await waitForJob(sent.payload.job.id);
  assert.equal(job.sent, 1, 'the message should still be delivered');
});

await test('deleting an attachment does not disturb already-sent history', async () => {
  const file = await upload('ephemeral.txt', 'x');
  const id = file.payload.attachments[0].id;

  const sent = await api('/api/send', {
    method: 'POST',
    body: {
      subject: 'History safety',
      html: '<p>x</p>',
      recipients: [{ name: '', email: 'ada@example.com' }],
      delayMs: 0,
      attachmentIds: [id],
    },
  });
  await waitForJob(sent.payload.job.id);

  const before = (await api('/api/messages?limit=1')).payload.total;
  await api(`/api/attachments/${id}`, { method: 'DELETE' });
  const after = (await api('/api/messages?limit=1')).payload.total;

  assert.equal(after, before, 'history rows must survive attachment deletion');
});

server.close();
await sleep(200);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
