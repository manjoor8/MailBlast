/**
 * Live demonstration against a running MailBlast server.
 *
 * Drives the exact same HTTP endpoints the browser UI uses, watching the
 * server-sent-events progress stream while a personalized campaign sends
 * one message at a time. Nothing is delivered — the seeded server runs in
 * capture mode.
 *
 * Run with:  node test/demo.js
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3210';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(routePath, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${routePath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${routePath} → ${response.status} ${payload?.error ?? text}`);
  return payload;
}

const rule = (label) => console.log(`\n${'─'.repeat(64)}\n${label}\n${'─'.repeat(64)}`);

/* ------------------------------------------------------------------ 1. health */

rule('1. Server status');
const health = await api('/api/health');
console.log(`  transport : ${health.transport.label}`);
console.log(`  contacts  : ${health.counts.contacts}`);
console.log(`  messages  : ${health.counts.messages} (${health.counts.sent} sent)`);

/* --------------------------------------------------------------- 2. contacts */

rule('2. Contacts already imported');
const { contacts, total } = await api('/api/contacts?limit=100');
console.log(`  ${total} contacts on file. First 4:`);
for (const contact of contacts.slice(0, 4)) {
  const tags = contact.tags.length ? `  [${contact.tags.join(', ')}]` : '';
  console.log(`    • ${contact.name || '(no name)'} <${contact.email}>${tags}`);
}

/* ----------------------------------------------------------------- 3. import */

rule('3. Import a new contact from pasted CSV');
const csv = 'Full Name,Email,Company,Tags\nDorothy Vaughan,dorothy@nasa.test,NASA,"demo, vip"';
const imported = await api('/api/contacts/import', { method: 'POST', body: { csv, tags: ['live-demo'] } });
console.log(`  created=${imported.created} updated=${imported.updated} unique=${imported.unique}`);
const preview = imported.preview[0];
console.log(`  → ${preview.name} <${preview.email}> tags: ${preview.tags.join(', ')}`);

/* ---------------------------------------------------------------- 4. preview */

rule('4. Personalization preview (what one recipient will see)');
const template = {
  subject: 'Hi {{first_name}} — a note for {{company}}',
  html: `<h1>Hello {{name}}</h1>
<p>This message was rendered for <strong>{{first_name}}</strong> at {{company}} on {{date}}.</p>
<p style="color:#8b95a3">Sent to {{email}}</p>`,
};
const rendered = await api('/api/preview', {
  method: 'POST',
  body: { ...template, contact: preview },
});
console.log(`  subject : ${rendered.subject}`);
console.log(`  body    : ${rendered.text.replace(/\n/g, ' / ').slice(0, 110)}…`);
console.log(`  tokens  : ${rendered.tokens.join(', ')}`);

/* ------------------------------------------------------------------- 5. send */

rule('5. Send a personalized campaign, one message at a time');

const recipients = contacts.slice(0, 5).map((c) => ({
  id: c.id, name: c.name, email: c.email, company: c.company,
}));
recipients.push({ id: preview.id, name: preview.name, email: preview.email, company: preview.company });

console.log(`  queueing ${recipients.length} recipients…`);

const started = await api('/api/send', {
  method: 'POST',
  body: {
    subject: template.subject,
    html: template.html,
    recipients,
    personalize: true,
    delayMs: 300,
    campaignName: 'Live demo run',
  },
});
console.log(`  job ${started.job.id.slice(0, 8)} accepted, ${started.job.total} messages queued`);

// Watch the live progress stream, exactly as the browser does.
// Node has no global EventSource, so read the SSE stream directly.
const response = await fetch(`${BASE}/api/events?job=${encodeURIComponent(started.job.id)}`);
const reader = response.body.getReader();
const decoder = new TextDecoder();

let buffer = '';
let lastProcessed = -1;
const deadline = Date.now() + 40_000;
let finished = false;

try {
  while (!finished && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;

      const job = JSON.parse(dataLine.slice(6));
      if (job.processed !== lastProcessed) {
        lastProcessed = job.processed;
        const who = job.current ? ` → ${job.current.email}` : '';
        console.log(
          `  [${String(job.percent).padStart(3)}%] ${job.processed}/${job.total} processed · ` +
            `${job.sent} sent · ${job.failed} failed${who}`,
        );
      }

      if (!['running', 'queued', 'cancelling'].includes(job.status)) {
        console.log(`  finished with status: ${job.status}`);
        finished = true;
        break;
      }
    }
  }
} finally {
  await reader.cancel().catch(() => {});
}

/* ---------------------------------------------------------------- 6. history */

rule('6. Sent history — search across subject and body');
const history = await api('/api/messages?limit=6&order=newest');
console.log(`  ${history.total} messages in total. Most recent 6:`);
for (const message of history.messages) {
  console.log(`    [${message.status.padEnd(7)}] ${message.subject}`);
}

const search = await api(`/api/messages?q=${encodeURIComponent('Dorothy')}`);
console.log(`\n  search "Dorothy" → ${search.total} match(es)`);
for (const message of search.messages) {
  console.log(`    ${message.name} <${message.email}>`);
  console.log(`    subject: ${message.subject}`);
}

const bodySearch = await api(`/api/messages?q=${encodeURIComponent('rendered for')}`);
console.log(`\n  search body text "rendered for" → ${bodySearch.total} match(es)`);

/* ------------------------------------------------------------------ 7. stats */

rule('7. Aggregates');
const stats = await api('/api/stats');
console.log(`  total ${stats.totals.total} · sent ${stats.totals.sent} · failed ${stats.totals.failed} · skipped ${stats.totals.skipped}`);
console.log(`  contacts on file: ${stats.contacts}`);
console.log('  campaigns:');
for (const campaign of stats.campaigns.slice(0, 4)) {
  console.log(`    • ${campaign.name} — ${campaign.sent}/${campaign.total} sent (${campaign.status})`);
}

console.log(`\n${'─'.repeat(64)}`);
console.log('Live demo complete. Open the UI to see it all:');
console.log(`  ${BASE}/#/compose     compose + live preview`);
console.log(`  ${BASE}/#/contacts    imported contacts`);
console.log(`  ${BASE}/#/sent        searchable sent history`);
console.log(`  ${BASE}/#/settings    SMTP configuration`);
console.log(`${'─'.repeat(64)}\n`);
