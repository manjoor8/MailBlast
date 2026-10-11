/**
 * Seed demo data into a running MailBlast instance so the UI can be exercised
 * with realistic content. Uses only the public HTTP API.
 *
 * Run with:  node test/seed.js  (BASE_URL to point elsewhere)
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3210';

const CONTACTS = [
  ['Ada Lovelace', 'ada@analytical-engines.test', 'Analytical Engines', 'vip, newsletter'],
  ['Grace Hopper', 'grace@navy.test', 'US Navy', 'vip'],
  ['Alan Turing', 'alan@bletchley.test', 'Bletchley Park', 'newsletter'],
  ['Katherine Johnson', 'katherine@nasa.test', 'NASA', 'vip, partners'],
  ['Margaret Hamilton', 'margaret@mit.test', 'MIT Instrumentation Lab', 'partners'],
  ['Barbara Liskov', 'barbara@mit.test', 'MIT', 'newsletter'],
  ['Radia Perlman', 'radia@dec.test', 'Digital Equipment Corp', ''],
  ['Hedy Lamarr', 'hedy@mgm.test', 'MGM', 'newsletter'],
  ['Shafi Goldwasser', 'shafi@weizmann.test', 'Weizmann Institute', 'partners'],
  ['Frances Allen', 'frances@ibm.test', 'IBM', 'vip'],
  ['Jean Bartik', 'jean@eniac.test', 'ENIAC', ''],
  ['Evelyn Boyd Granville', 'evelyn@ibm.test', 'IBM', 'newsletter'],
  ['Adele Goldberg', 'adele@parc.test', 'Xerox PARC', 'partners'],
  ['Carol Shaw', 'carol@atari.test', 'Atari', ''],
  ['Lynn Conway', 'lynn@parc.test', 'Xerox PARC', 'vip, newsletter'],
  ['Sophie Wilson', 'sophie@acorn.test', 'Acorn Computers', ''],
  ['Erna Hoover', 'erna@bell.test', 'Bell Labs', 'partners'],
  ['Thelma Estrin', 'thelma@ucla.test', 'UCLA', 'newsletter'],
  ['Mary Lee Woods', 'mary@npl.test', 'National Physical Laboratory', ''],
  ['Klara Dan von Neumann', 'klara@ias.test', 'Institute for Advanced Study', 'newsletter'],
];

const SUBJECT = 'Hi {{first_name}} — a quick note for {{company}}';

const HTML = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1f24;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 12px;font-size:22px;">Hi {{first_name}},</h1>
        <p style="margin:0 0 16px;line-height:1.6;color:#3a4149;">
          You are receiving this because you are on our list as <strong>{{name}}</strong>
          at <strong>{{company}}</strong>. This message was rendered just for you on {{date}} —
          every recipient gets their own copy, sent one at a time.
        </p>
        <p style="margin:0 0 24px;line-height:1.6;color:#3a4149;">
          If anything looks wrong, reply to this message and a human will pick it up.
        </p>
        <p style="margin:0;">
          <a href="https://example.com/dashboard" style="display:inline-block;background:#2f6df6;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;">Open your dashboard</a>
        </p>
        <p style="margin:28px 0 0;font-size:13px;color:#8b95a3;">Cheers,<br />The MailBlast team</p>
      </td></tr>
    </table>
  </body>
</html>`;

const api = async (routePath, options = {}) => {
  const response = await fetch(`${BASE}${routePath}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${routePath} → ${response.status} ${payload?.error ?? text}`);
  return payload;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`Seeding ${BASE} …`);

// Safe, offline demo transport.
await api('/api/settings', {
  method: 'PUT',
  body: {
    smtp: {
      captureMode: true,
      fromName: 'MailBlast Demo',
      fromEmail: 'hello@example.com',
      replyTo: 'replies@example.com',
    },
  },
});
console.log('  capture mode enabled (nothing will actually be delivered)');

const csv = ['Name,Email,Company,Tags', ...CONTACTS.map((row) => row.map((v) => (v.includes(',') ? `"${v}"` : v)).join(','))].join('\n');
const imported = await api('/api/contacts/import', { method: 'POST', body: { csv, tags: ['demo'] } });
console.log(`  contacts: ${imported.created} created, ${imported.skippedExisting} already present`);

const { contacts } = await api('/api/contacts?limit=100');
const recipients = contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, company: c.company }));

const started = await api('/api/send', {
  method: 'POST',
  body: {
    subject: SUBJECT,
    html: HTML,
    recipients,
    personalize: true,
    delayMs: 0,
    campaignName: 'October product update',
  },
});
console.log(`  sending campaign "${'October product update'}" to ${started.job.total} contacts…`);

let job = await api(`/api/jobs/${started.job.id}`);
const deadline = Date.now() + 30_000;
while (['running', 'queued', 'cancelling'].includes(job.status) && Date.now() < deadline) {
  await sleep(200);
  job = await api(`/api/jobs/${started.job.id}`);
}
console.log(`  campaign ${job.status}: ${job.sent} sent, ${job.failed} failed`);

// A second, smaller campaign so the history has more than one group.
await api('/api/send', {
  method: 'POST',
  body: {
    subject: 'Vip only: {{first_name}}, early access is open',
    html: '<p>Hi {{first_name}} — you are on the early-access list for {{company}}.</p>',
    recipients: recipients.slice(0, 5),
    personalize: true,
    delayMs: 0,
    campaignName: 'Early access (VIPs)',
  },
});
await sleep(1200);

const stats = await api('/api/stats');
console.log(`  history now holds ${stats.totals.total} messages across ${stats.campaigns.length} campaigns`);
console.log('Done.');
