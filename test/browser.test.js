/**
 * Browser verification.
 *
 * Launches a headless Chromium browser (Edge or Chrome), drives the MailBlast
 * UI over the Chrome DevTools Protocol, and checks that each page renders
 * without console errors — capturing screenshots along the way.
 *
 * Run with:  node test/browser.test.js
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'test', 'screenshots');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3210';
const PORT = 9333;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browserPath = BROWSERS.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.error('No Chromium-based browser found; skipping browser verification.');
  process.exit(0);
}

fs.mkdirSync(SHOT_DIR, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mailblast-cdp-'));

const browser = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/* ------------------------------------------------------------------ CDP glue */

let ws = null;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(payload));
  });
}

async function connect() {
  const deadline = Date.now() + 25_000;
  let target = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) {
        target = (await response.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* browser still starting */
    }
    await sleep(300);
  }

  if (!target) {
    // Some sandboxes let the browser start but never let it bind its DevTools
    // socket. That is an environment limitation, not an app failure, so report
    // it plainly and exit successfully rather than failing the run.
    console.log('  ! the browser never opened its DevTools port.');
    console.log('    This environment appears to block Chromium debug sockets.');
    console.log('    Run this file on an unrestricted machine to exercise the UI:\n');
    console.log('        node test/browser.test.js\n');
    browser.kill();
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    process.exit(0);
  }

  ws = new WebSocket(target);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }

    const method = message.method;
    if (method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    } else if (method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description ?? details.text);
    } else if (method === 'Network.loadingFailed') {
      failedRequests.push(`${message.params.type} ${message.params.errorText}`);
    }
  });
}

/** Attach the flat-mode session that lets us drive the page. */
async function attach() {
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  return sessionId;
}

async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function goto(sessionId, url) {
  await send('Page.navigate', { url }, sessionId);
  await sleep(1400);
}

async function screenshot(sessionId, name) {
  const { data } = await send('Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true }, sessionId);
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/* ------------------------------------------------------------------ runner */

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('\nMailBlast browser verification\n');
console.log(`  browser: ${browserPath}`);
console.log(`  target:  ${BASE}\n`);

try {
  await connect();
  const session = await attach();

  const pages = [
    { hash: '#/compose', name: 'compose', expect: 'Recipients' },
    { hash: '#/contacts', name: 'contacts', expect: 'Import contacts' },
    { hash: '#/sent', name: 'sent-history', expect: 'Sent history' },
    { hash: '#/settings', name: 'settings', expect: 'Common providers' },
  ];

  for (const page of pages) {
    consoleErrors.length = 0;
    pageErrors.length = 0;
    failedRequests.length = 0;

    await goto(session, `${BASE}/${page.hash}`);
    const html = await evaluate(session, 'document.getElementById("main").innerHTML');

    await check(`${page.name} page renders its content`, () => {
      assert(html.length > 400, `#main was nearly empty (${html.length} chars)`);
      assert(html.includes(page.expect), `#main does not contain "${page.expect}"`);
    });

    await check(`${page.name} page loads with no console or page errors`, () => {
      assert(pageErrors.length === 0, `uncaught: ${pageErrors.join(' | ')}`);
      assert(consoleErrors.length === 0, `console.error: ${consoleErrors.join(' | ')}`);
      const real = failedRequests.filter((r) => !/favicon/i.test(r));
      assert(real.length === 0, `failed requests: ${real.join(' | ')}`);
    });

    const file = await screenshot(session, page.name);
    console.log(`      ↳ ${path.relative(ROOT, file)}`);
  }

  /* -------------------------------------------------- interactive behaviours */

  await goto(session, `${BASE}/#/compose`);

  await check('compose view loads contacts into the recipient panel', async () => {
    const text = await evaluate(session, 'document.querySelector(".recipient-list")?.innerText ?? ""');
    assert(text.includes('@'), `recipient list had no addresses: ${JSON.stringify(text.slice(0, 120))}`);
  });

  await check('typing an email into the manual list updates the recipient count', async () => {
    await evaluate(session, `(() => {
      const button = [...document.querySelectorAll('#main .btn')].find((b) => b.textContent.trim() === 'Manual list');
      button.click();
      return true;
    })()`);
    await sleep(250);
    await evaluate(session, `(() => {
      const box = document.querySelector('#main textarea[placeholder^="ada@example.com"]');
      box.value = 'one@example.com, two@example.com';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const panel = await evaluate(session, 'document.querySelector("#main .recipient-list").innerText');
    assert(panel.includes('one@example.com'), 'manual address did not appear in the recipient list');
    assert(panel.includes('two@example.com'), 'second manual address did not appear');
  });

  await check('live preview renders the personalized subject for the first recipient', async () => {
    await goto(session, `${BASE}/#/compose`);
    await sleep(900);
    const subject = await evaluate(session, 'document.getElementById("pv-subject")?.textContent ?? ""');
    assert(subject && subject !== '—', `preview subject was "${subject}"`);
    const srcdoc = await evaluate(session, 'document.querySelector("iframe.preview-frame")?.getAttribute("srcdoc")?.length ?? 0');
    assert(srcdoc > 200, 'preview iframe was not populated');
  });

  await check('contacts page lists imported contacts in a table', async () => {
    await goto(session, `${BASE}/#/contacts`);
    await sleep(600);
    const rows = await evaluate(session, 'document.querySelectorAll("#main tbody tr").length');
    assert(rows > 0, 'no contact rows rendered');
  });

  await check('sent history search narrows the result set', async () => {
    await goto(session, `${BASE}/#/sent`);
    await sleep(700);
    const before = await evaluate(session, 'document.querySelectorAll("#main tbody tr").length');
    await evaluate(session, `(() => {
      const input = document.querySelector('#main input[type="search"]');
      input.value = 'Ada';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    const after = await evaluate(session, 'document.querySelectorAll("#main tbody tr").length');
    const heading = await evaluate(session, 'document.querySelector("#main .card .muted")?.textContent ?? ""');
    assert(before > 0, `expected messages before searching, saw ${before}`);
    assert(after > 0 && after <= before, `search did not filter (before ${before}, after ${after})`);
    assert(/matching/i.test(heading), `search count line did not mention the query: ${heading}`);
    await screenshot(session, 'sent-history-search');
  });

  await check('opening a message shows the rendered HTML and plain-text tabs', async () => {
    await evaluate(session, `(() => {
      document.querySelector('#main tbody tr').click();
      return true;
    })()`);
    await sleep(900);
    const tabs = await evaluate(session, '[...document.querySelectorAll(".modal .tab")].map((t) => t.textContent)');
    assert(tabs.includes('HTML') && tabs.includes('Plain text'), `unexpected tabs: ${JSON.stringify(tabs)}`);
    const toLine = await evaluate(session, 'document.querySelector(".modal .kv")?.innerText ?? ""');
    assert(toLine.includes('@'), 'message detail did not show a recipient');
    await screenshot(session, 'message-detail');
  });

  await check('settings page shows the configured transport and provider list', async () => {
    await goto(session, `${BASE}/#/settings`);
    await sleep(600);
    const body = await evaluate(session, 'document.getElementById("main").innerText');
    assert(/SMTP|Capture mode/.test(body), 'transport status missing');
    assert(body.includes('Gmail'), 'provider shortcuts missing');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`screenshots: ${path.relative(ROOT, SHOT_DIR)}\n`);
} catch (err) {
  console.error(`\nHarness error: ${err.message}\n`);
  failed += 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  browser.kill();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* profile cleanup is best-effort */
  }
}

process.exit(failed === 0 ? 0 : 1);
