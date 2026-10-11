/**
 * View rendering test.
 *
 * Runs the real view modules (public/js/views/*.js) inside a minimal DOM shim
 * and a stubbed fetch, so a page render failure — a missing import, a bad
 * element spec, reading a property that does not exist — surfaces as a test
 * failure instead of a blank screen in a browser.
 *
 * Run with:  node test/views.test.js
 */

import assert from 'node:assert/strict';
import {
  FakeNode,
  FakeTextNode,
  installDom,
  installFetch,
  jsonResponse,
  textOf,
  isHidden,
} from './helpers/dom.mjs';

/* --------------------------------------------------------------- DOM shim */

installDom();

const { document } = globalThis;

/* --------------------------------------------------------------- fetch stub */

const CONTACTS = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', tags: ['vip', 'demo'], createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z' },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.com', company: 'US Navy', tags: ['vip'], createdAt: '2026-01-03T10:00:00.000Z', updatedAt: '2026-01-03T10:00:00.000Z' },
  { id: 3, name: '', email: 'noname@example.com', company: '', tags: [], createdAt: '2026-01-04T10:00:00.000Z', updatedAt: '2026-01-04T10:00:00.000Z' },
];

const MESSAGES = [
  {
    id: 11, campaignId: 1, campaignName: 'October update', name: 'Ada Lovelace', email: 'ada@example.com',
    subject: 'Hi Ada — a note for Analytical Engines', html: '<p>Hello Ada Lovelace</p>', status: 'sent',
    error: null, response: '250 OK', transport: 'capture', sentAt: '2026-01-05T09:00:00.000Z', createdAt: '2026-01-05T09:00:00.000Z',
  },
  {
    id: 12, campaignId: 1, campaignName: 'October update', name: 'Grace Hopper', email: 'grace@example.com',
    subject: 'Hi Grace — a note for US Navy', html: '<p>Hello Grace Hopper</p>', status: 'sent',
    error: null, response: '250 OK', transport: 'capture', sentAt: '2026-01-05T09:00:01.000Z', createdAt: '2026-01-05T09:00:01.000Z',
  },
  {
    id: 13, campaignId: 2, campaignName: 'Bad batch', name: 'Broken', email: 'broken@example.com',
    subject: 'This one failed', html: '<p>nope</p>', status: 'failed', error: '550 mailbox unavailable',
    response: null, transport: 'capture', sentAt: null, createdAt: '2026-01-06T09:00:00.000Z',
  },
];

const settingsPayload = {
  smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'me@example.com', hasPassword: true, fromName: 'Demo', fromEmail: 'hello@example.com', replyTo: '', captureMode: false },
  transport: { kind: 'smtp', label: 'SMTP smtp.example.com:587' },
  configured: true,
  defaults: { delayMs: 250, personalize: true },
  tokens: [],
};

const statsPayload = {
  totals: { total: 3, sent: 2, failed: 1, skipped: 0 },
  contacts: 3,
  recent: [],
  topRecipients: [],
  campaigns: [
    { id: 1, name: 'October update', subject: 'Hi', total: 2, sent: 2, failed: 0, status: 'completed', created_at: '', finished_at: '' },
    { id: 2, name: 'Bad batch', subject: 'x', total: 1, sent: 0, failed: 1, status: 'failed', created_at: '', finished_at: '' },
  ],
};

const draftsPayload = {
  total: 2,
  drafts: [
    {
      id: 4, name: 'October update', subject: 'Hi {{first_name}}', html: '<p>Body of the first draft</p>',
      fromName: 'Manjoor', personalize: true, delayMs: 250, recipientMode: 'all', tags: [], manual: '',
      attachmentIds: [1, 2], createdAt: '2026-01-05T09:00:00.000Z', updatedAt: '2026-01-06T09:00:00.000Z',
    },
    {
      id: 5, name: 'Cold outreach', subject: 'Quick question', html: '<p>Second draft body</p>',
      fromName: '', personalize: false, delayMs: 0, recipientMode: 'tags', tags: ['vip'], manual: '',
      attachmentIds: [], createdAt: '2026-01-04T09:00:00.000Z', updatedAt: '2026-01-04T09:00:00.000Z',
    },
  ],
};

const calls = [];

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  const parsed = new URL(href, 'http://localhost');
  const route = parsed.pathname;
  const query = parsed.searchParams;
  calls.push({ route, method: options.method ?? 'GET' });

  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

  if (route === '/api/settings') return json(settingsPayload);
  if (route === '/api/contacts/tags') {
    return json({ tags: [{ tag: 'vip', count: 2 }, { tag: 'demo', count: 1 }] });
  }
  if (route === '/api/contacts') {
    const q = (query.get('q') ?? '').toLowerCase();
    const filtered = q
      ? CONTACTS.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(q))
      : CONTACTS;
    return json({ total: filtered.length, limit: 25, offset: 0, contacts: filtered });
  }
  if (route === '/api/messages') {
    const q = (query.get('q') ?? '').toLowerCase();
    const filtered = q
      ? MESSAGES.filter((m) => `${m.name} ${m.email} ${m.subject}`.toLowerCase().includes(q))
      : MESSAGES;
    return json({ total: filtered.length, limit: 25, offset: 0, messages: filtered });
  }
  if (route.startsWith('/api/messages/')) {
    const id = Number(route.split('/').pop());
    const found = MESSAGES.find((m) => m.id === id);
    if (!found) return json({ error: 'Message not found.' }, 404);
    return json({ ...found, text: 'Hello Ada Lovelace' });
  }
  if (route === '/api/stats') return json(statsPayload);
  if (route === '/api/drafts') return json(draftsPayload);
  if (route === '/api/attachments') {
    return json({
      attachments: [
        { id: 1, filename: 'report.pdf', contentType: 'application/pdf', size: 20480, createdAt: '2026-01-05T09:00:00.000Z' },
      ],
      limits: { maxFileBytes: 26214400, maxTotalBytes: 41943040 },
    });
  }
  if (route === '/api/health') {
    return json({ ok: true, transport: settingsPayload.transport, configured: true, counts: { contacts: 3, messages: 3, sent: 2 } });
  }
  if (route === '/api/preview') {
    const body = JSON.parse(options.body ?? '{}');
    return json({
      subject: String(body.subject ?? '').replace(/\{\{\s*first_name\s*\}\}/gi, 'Ada'),
      html: String(body.html ?? '').replace(/\{\{\s*name\s*\}\}/gi, 'Ada Lovelace'),
      text: 'plain text version',
      sample: { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines' },
      tokens: ['first_name'],
    });
  }
  if (route === '/api/jobs') return json({ jobs: [] });
  if (route === '/api/jobs/abc') {
    return json({
      id: 'abc', campaignId: 1, status: 'completed', total: 2, processed: 2, sent: 2, failed: 0, skipped: 0,
      percent: 100, current: null, startedAt: '', finishedAt: '', delayMs: 0,
      entries: [
        { index: 0, name: 'Ada', email: 'ada@example.com', status: 'sent', error: null, sentAt: '2026-01-05T09:00:00.000Z' },
        { index: 1, name: 'Grace', email: 'grace@example.com', status: 'sent', error: null, sentAt: '2026-01-05T09:00:01.000Z' },
      ],
    });
  }
  if (route === '/api/send') {
    return json({ ok: true, invalidSkipped: 0, job: { id: 'abc', total: 2, entries: [], status: 'queued', sent: 0, failed: 0, skipped: 0, processed: 0, percent: 0, current: null } }, 202);
  }
  if (route === '/api/send/test') return json({ ok: true, id: 99, status: 'sent' });
  if (route === '/api/settings/test') return json({ ok: true, message: 'Connected.' });
  return json({ error: `no stub for ${route}` }, 404);
};

/* ------------------------------------------------------------------- runner */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ')}`);
  }
}

console.log('\nMailBlast view rendering\n');

const { renderCompose } = await import('../public/js/views/compose.js');
const { renderDrafts } = await import('../public/js/views/drafts.js');
const { renderContacts } = await import('../public/js/views/contacts.js');
const { renderSent } = await import('../public/js/views/sent.js');
const { renderSettings } = await import('../public/js/views/settings.js');

await test('compose view renders a visual editor plus recipients and send controls', async () => {
  const view = await renderCompose();
  const text = textOf(view);
  assert.match(text, /Campaign name/);
  assert.match(text, /Subject/);
  assert.match(text, /Message/);
  assert.match(text, /Recipients/);
  assert.match(text, /Personalize each message/);

  // The message is written in a WYSIWYG surface, not a raw HTML textarea.
  const editor = view.querySelector('.editor');
  assert.ok(editor, 'the visual editor is missing');
  const surface = view.querySelector('.editor-surface');
  assert.ok(surface, 'the contenteditable surface is missing');
  assert.equal(surface.getAttribute('contenteditable'), 'true', 'the surface must be editable');
  assert.ok(view.querySelector('.editor-toolbar'), 'the editor toolbar is missing');
  assert.ok(view.querySelector('textarea.editor-code'), 'the editor should still offer an HTML source view');

  assert.ok(view.querySelector('iframe.preview-frame'), 'preview iframe missing');
});

await test('the recipients picker lists every contact with its own checkbox', async () => {
  const view = await renderCompose();
  const list = view.querySelector('.recipient-list');
  assert.ok(list, 'the recipient picker is missing');

  const boxes = list.querySelectorAll('input').filter((input) => input.attributes.type === 'checkbox');
  assert.equal(boxes.length, 3, `expected one checkbox per contact, got ${boxes.length}`);

  // Every contact is visible, whether or not it is ticked.
  const text = textOf(list);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /grace@example\.com/);
  assert.match(text, /noname@example\.com/, 'a contact without a name is still listed');

  // Nothing is selected to begin with, so a send cannot happen by accident.
  assert.ok(boxes.every((box) => box.checked === false), 'no contact should start selected');
});

await test('ticking a contact selects it and updates the send button', async () => {
  const view = await renderCompose();
  const list = view.querySelector('.recipient-list');
  const boxes = list.querySelectorAll('input').filter((input) => input.attributes.type === 'checkbox');

  boxes[0].checked = true;
  boxes[0].fire('change');

  const sendButton = view.querySelectorAll('button.btn-primary').find((b) => /^Send to/.test(textOf(b)));
  assert.ok(sendButton, 'the send button is missing');
  assert.match(textOf(sendButton), /Send to 1 person/, `got "${textOf(sendButton)}"`);
  assert.equal(sendButton.disabled, false, 'the send button should enable once someone is selected');

  // Ticking a second one counts both.
  const refreshed = view
    .querySelector('.recipient-list')
    .querySelectorAll('input')
    .filter((input) => input.attributes.type === 'checkbox');
  refreshed[1].checked = true;
  refreshed[1].fire('change');
  assert.match(textOf(sendButton), /Send to 2 people/);
});

await test('select all ticks every visible contact and clear empties the selection', async () => {
  const view = await renderCompose();

  // The select-all box is the one inside the toolbar, next to its label.
  const toolbarBox = view
    .querySelectorAll('.toolbar input')
    .find((input) => input.attributes.type === 'checkbox');
  assert.ok(toolbarBox, 'the select-all checkbox is missing');

  toolbarBox.checked = true;
  toolbarBox.fire('change');

  let boxes = view.querySelector('.recipient-list').querySelectorAll('input');
  assert.equal(boxes.filter((b) => b.checked).length, 3, 'select all should tick every listed contact');

  const clear = view.querySelectorAll('button.btn').find((b) => textOf(b) === 'Clear selection');
  assert.ok(clear, 'the clear-selection button is missing');
  clear.click();

  boxes = view.querySelector('.recipient-list').querySelectorAll('input');
  assert.equal(boxes.filter((b) => b.checked).length, 0, 'clear should untick everything');
});

await test('searching narrows the recipient list by name and email', async () => {
  const view = await renderCompose();
  const search = view
    .querySelectorAll('input')
    .find((input) => input.attributes.type === 'search');
  assert.ok(search, 'the recipient search box is missing');

  // By name.
  search.value = 'grace';
  search.fire('input');
  let text = textOf(view.querySelector('.recipient-list'));
  assert.match(text, /Grace Hopper/);
  assert.ok(!/Ada Lovelace/.test(text), 'non-matching contacts should be hidden');

  // By email.
  search.value = 'noname@';
  search.fire('input');
  text = textOf(view.querySelector('.recipient-list'));
  assert.match(text, /noname@example\.com/);
  assert.ok(!/Grace Hopper/.test(text));

  // No match.
  search.value = 'zzzz-nobody';
  search.fire('input');
  assert.match(textOf(view.querySelector('.recipient-list')), /No contact matches/i);

  // Clearing restores everyone.
  search.value = '';
  search.fire('input');
  assert.equal(
    view.querySelector('.recipient-list').querySelectorAll('input').filter((i) => i.attributes.type === 'checkbox').length,
    3,
  );
});

await test('the recipient picker flags a contact with no name', async () => {
  const view = await renderCompose();
  assert.match(textOf(view.querySelector('.recipient-list')), /no name/);
});

await test('the compose editor starts in visual mode with the toolbar visible', async () => {
  const view = await renderCompose();
  const surface = view.querySelector('.editor-surface');
  const code = view.querySelector('textarea.editor-code');
  assert.equal(isHidden(surface), false, 'the visual surface should be visible by default');
  assert.equal(isHidden(code), true, 'the HTML source view should be hidden by default');
  assert.equal(isHidden(view.querySelector('.editor-toolbar')), false, 'the toolbar should be visible');
  // Both mode tabs must be offered.
  const tabs = view.querySelectorAll('.editor-modebar .tab').map((t) => textOf(t));
  assert.deepEqual(tabs, ['Visual', 'HTML source']);
});

await test('the compose editor offers a personalization token menu', async () => {
  const view = await renderCompose();
  const select = view
    .querySelectorAll('.editor-toolbar select')
    .find((node) => (node.children ?? []).some((option) => /first_name/.test(textOf(option))));
  assert.ok(select, 'the personalize menu is missing from the toolbar');
  const options = select.children.map((option) => textOf(option));
  assert.ok(options.some((label) => /Full name/.test(label)));
  assert.ok(options.some((label) => /\{\{first_name\}\}/.test(label)));
});

await test('compose preview requests a personalized render after the debounce', async () => {
  calls.length = 0;
  await renderCompose();
  // The preview is debounced by 400 ms in the view.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(calls.some((c) => c.route === '/api/preview'), 'preview was never requested');
});

await test('compose view explains that the personalization checkbox exists', async () => {
  const view = await renderCompose();
  // The label text must be present in the DOM, whether via textContent or html.
  const label = view.querySelectorAll('label').find((l) => /Personalize each message/.test(l.innerHTML + textOf(l)));
  assert.ok(label, 'the "Personalize each message" label is missing from the DOM');
  const checkbox = view.querySelectorAll('input').find((i) => i.attributes.type === 'checkbox' && i.checked);
  assert.ok(checkbox, 'the personalization checkbox should be checked by default');
});

await test('compose view keeps the personalization toggle off when unticked', async () => {
  const view = await renderCompose();
  const checkbox = view
    .querySelectorAll('input')
    .find((input) => input.attributes.type === 'checkbox' && /Personalize each message/.test(
      input.parentNode?.textContent ?? '',
    ));
  assert.ok(checkbox, 'personalize checkbox should default to on');
  checkbox.checked = false;
  checkbox.fire('change');
  assert.equal(checkbox.checked, false);
});

await test('the manual address box is always available alongside the picker', async () => {
  const view = await renderCompose();
  const box = view
    .querySelectorAll('textarea')
    .find((t) => (t.attributes.placeholder ?? '').includes('Extra addresses') || (t.attributes.placeholder ?? '').startsWith('Or type extra'));
  assert.ok(box, 'the extra-addresses box is missing');

  box.value = 'one@example.com, two@example.com';
  box.fire('input');
  const panel = textOf(view.querySelector('.recipient-list'));
  // The picker itself is unaffected; the manual addresses are counted as recipients.
  assert.ok(!/one@example\.com/.test(panel), 'manual addresses are not contacts in the picker');
  const summary = textOf(view);
  assert.match(summary, /2 recipients selected/, 'typed addresses should count towards the selection');
});

await test('compose view loads a starter template into the editor', async () => {
  const view = await renderCompose();
  const surface = view.querySelector('.editor-surface');
  const picker = view
    .querySelectorAll('select')
    .find((node) => (node.children ?? []).some((option) => /Newsletter/.test(textOf(option))));
  assert.ok(picker, 'the template picker is missing');

  picker.value = 'Newsletter';
  picker.fire('change');

  assert.match(surface.innerHTML, /Monthly digest|Hello/, 'the template was not loaded into the visual editor');
});

await test('contacts view renders a table of contacts with tags', async () => {
  const view = await renderContacts();
  const rows = view.querySelectorAll('tbody tr');
  assert.equal(rows.length, 3, `expected 3 contact rows, got ${rows.length}`);
  const text = textOf(view);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /grace@example\.com/);
  assert.match(text, /vip/);
  assert.match(text, /Export CSV/);
});

await test('contacts view paginates using the reported total', async () => {
  const view = await renderContacts();
  assert.match(textOf(view.querySelector('.pager')), /Page 1 of 1/);
});

await test('sent view renders message rows with status badges', async () => {
  const view = await renderSent();
  const rows = view.querySelectorAll('tbody tr');
  assert.equal(rows.length, 3, `expected 3 message rows, got ${rows.length}`);
  const text = textOf(view);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /Hi Ada — a note for Analytical Engines/);
  assert.match(text, /550 mailbox unavailable/);
  assert.ok(view.querySelectorAll('.badge-sent').length >= 2, 'sent badges missing');
  assert.ok(view.querySelectorAll('.badge-failed').length >= 1, 'failed badge missing');
});

await test('sent view shows summary statistics', async () => {
  const view = await renderSent();
  const text = textOf(view.querySelector('.grid-stats'));
  assert.match(text, /Messages/);
  assert.match(text, /Delivered/);
  assert.match(text, /Failed/);
  assert.match(text, /Contacts/);
  const values = view.querySelectorAll('.stat .value').map((node) => textOf(node));
  assert.deepEqual(values, ['3', '2', '1', '3']);
});

await test('sent view pagination reports the visible range', async () => {
  const view = await renderSent();
  assert.match(textOf(view.querySelector('.pager')), /Showing 1–3 of 3/);
});
await test('sent view opens a message detail modal with HTML and text tabs', async () => {
  const view = await renderSent();
  view.querySelectorAll('tbody tr')[0].click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const modalRoot = document.getElementById('modal-root');
  const text = textOf(modalRoot);
  assert.match(text, /Hello Ada Lovelace|Plain text|HTML/, 'detail modal did not render');
  const tabs = modalRoot.querySelectorAll('.tab');
  assert.equal(tabs.length, 2, 'expected HTML and Plain text tabs');
  assert.equal(tabs[0].classList.contains('active'), true, 'HTML tab should start active');
  tabs[1].click();
  assert.equal(tabs[1].classList.contains('active'), true, 'clicking should activate the text tab');
  assert.equal(tabs[0].classList.contains('active'), false, 'the other tab should deactivate');
});

await test('the sent message preview fills the full modal width', async () => {
  const view = await renderSent();
  view.querySelectorAll('tbody tr')[0].click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const modalRoot = document.getElementById('modal-root');
  const frame = modalRoot.querySelector('iframe');
  assert.ok(frame, 'the HTML preview iframe is missing');

  // An iframe defaults to ~300px, so an unset width renders in a narrow column.
  assert.equal(frame.style.width, '100%', 'the preview must span the modal, not default to 300px');
  assert.equal(frame.style.display, 'block', 'inline display would leave it shrink-to-fit');

  // Its wrapper must not be allowed to collapse either.
  const host = frame.parentNode;
  assert.ok(host, 'the iframe should be wrapped');
  assert.equal(host.style.width, '100%');
  assert.equal(host.style.minWidth, '0', 'a flex/grid parent could otherwise shrink the wrapper');
});

await test('sent view applying a search re-queries the API with the query', async () => {
  const view = await renderSent();
  const input = view.querySelectorAll('input').find((i) => i.attributes.type === 'search');
  assert.ok(input, 'search input missing');
  calls.length = 0;
  input.value = 'grace';
  input.fire('input');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(calls.some((c) => c.route === '/api/messages'), 'search did not query /api/messages');
});

await test('settings view renders SMTP fields and the provider list', async () => {
  const view = await renderSettings();
  const text = textOf(view);
  assert.match(text, /SMTP host/);
  assert.match(text, /smtp\.example\.com/);
  assert.match(text, /Common providers/);
  assert.match(text, /Gmail/);
  assert.match(text, /Deliverability checklist/);
  assert.match(text, /Use implicit TLS/);
});

await test('settings view never receives the stored password', async () => {
  const view = await renderSettings();
  const text = textOf(view);
  assert.ok(!text.includes('undefined'), 'rendered "undefined" somewhere');
  const passwordInput = view.querySelectorAll('input').find((i) => i.attributes.type === 'password');
  assert.ok(passwordInput, 'password field missing');
  assert.equal(passwordInput.value, '', 'password field must render empty');
  assert.match(passwordInput.attributes.placeholder ?? '', /stored/, 'should show that a password is saved');
});

await test('settings view lets a provider shortcut fill in host and port', async () => {
  const view = await renderSettings();
  const useButton = view.querySelectorAll('button.btn').find((b) => textOf(b) === 'Use');
  assert.ok(useButton, 'provider "Use" button missing');
  useButton.click();
  const host = view.querySelectorAll('input').find((i) => (i.attributes.placeholder ?? '') === 'smtp.example.com');
  assert.equal(host.value, 'smtp.gmail.com', 'provider host was not applied');
});

await test('settings view warns that Microsoft is retiring password-based SMTP', async () => {
  const view = await renderSettings();
  const host = view.querySelectorAll('input').find((i) => (i.attributes.placeholder ?? '') === 'smtp.example.com');
  assert.ok(host, 'host input missing');

  const notice = view.querySelector('[data-notice]');
  assert.ok(notice, 'the Microsoft notice element is missing');
  assert.equal(notice.style.display, 'none', 'notice should start hidden');

  host.value = 'smtp-mail.outlook.com';
  host.fire('input');

  assert.notEqual(notice.style.display, 'none', 'notice should be shown for an outlook.com host');
  const text = textOf(notice);
  assert.match(text, /Microsoft is retiring password-based SMTP/);
  assert.match(text, /535 5\.7\.139/, 'the expected error code is not mentioned');

  // Switching away from Microsoft must hide it again, not just stop adding it.
  host.value = 'smtp.example.org';
  host.fire('input');
  assert.equal(notice.style.display, 'none', 'notice should be hidden for a non-Microsoft host');
  assert.equal(notice.children.length, 0, 'the hidden notice should also be emptied');
  // Only the notice contains this sentence; the provider preset uses different wording.
  assert.ok(
    !/mailboxes are moving to OAuth2-only/.test(textOf(view)),
    'hidden notice text must not leak into the view',
  );
});

await test('settings view offers a Microsoft OAuth2 auth mode', async () => {
  const view = await renderSettings();
  const text = textOf(view);
  assert.match(text, /Authentication/, 'auth mode section missing');
  const oauthButton = view.querySelectorAll('button.btn').find((b) => textOf(b) === 'Microsoft OAuth2');
  assert.ok(oauthButton, 'Microsoft OAuth2 mode button missing');
  assert.match(text, /Microsoft sign-in \(OAuth2\)/, 'OAuth card missing');
  assert.match(text, /Application \(client\) ID/, 'client ID field missing');
  assert.match(text, /Sign in with Microsoft/, 'sign-in button missing');
});

await test('switching to OAuth2 mode hides the password fields', async () => {
  const view = await renderSettings();
  const passwordInput = view.querySelectorAll('input').find((i) => i.attributes.type === 'password');
  assert.ok(passwordInput, 'password field should exist in password mode');
  assert.ok(!isHidden(passwordInput), 'password field should be visible in password mode');

  const oauthButton = view.querySelectorAll('button.btn').find((b) => textOf(b) === 'Microsoft OAuth2');
  oauthButton.click();

  assert.ok(isHidden(passwordInput), 'password field should be hidden when OAuth2 is selected');

  const text = textOf(view);
  assert.match(text, /Client secret value/, 'OAuth card should be visible in OAuth2 mode');
  assert.match(text, /Sign in with Microsoft/, 'sign-in button should be reachable in OAuth2 mode');
});

await test('drafts view lists saved drafts with subject and recipient wording', async () => {
  const view = await renderDrafts();
  const text = textOf(view);

  assert.match(text, /Drafts/);
  assert.match(text, /October update/);
  assert.match(text, /Cold outreach/);
  assert.match(text, /Body of the first draft/, 'a body snippet should be shown');
  assert.match(text, /All contacts/, 'recipient mode should be readable');
  assert.match(text, /By tag: vip/);
});

await test('drafts view shows an attachment count only when files exist', async () => {
  const view = await renderDrafts();
  const text = textOf(view);
  assert.match(text, /2 files/, 'the first draft has two attachments');

  // The second draft has none, so exactly one pill should be rendered.
  const pills = view.querySelectorAll('tbody .pill').map((node) => textOf(node));
  assert.deepEqual(pills, ['2 files']);
});

await test('drafts view offers open, duplicate and delete actions', async () => {
  const view = await renderDrafts();
  const anchors = view.querySelectorAll('a').map((a) => a.getAttribute('href'));
  assert.ok(
    anchors.includes('#/compose?draft=4'),
    `an Open link should target the composer with the draft id, got ${JSON.stringify(anchors)}`,
  );

  const labels = view.querySelectorAll('button').map((b) => textOf(b));
  assert.ok(labels.includes('Duplicate'), 'a Duplicate action is required');
  assert.ok(labels.includes('Delete'), 'a Delete action is required');
});

await test('drafts view renders an empty state when there are none', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) =>
    String(url).includes('/api/drafts') ? jsonResponse({ total: 0, drafts: [] }) : original(url, options);

  const view = await renderDrafts();
  const text = textOf(view);
  assert.match(text, /No saved drafts/i, 'an empty state should explain there is nothing yet');

  globalThis.fetch = original;
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
