/**
 * Email editor tests.
 *
 * The editor is a `contenteditable` surface driven by `document.execCommand`,
 * which a test environment cannot implement. So `execCommand` is stubbed with a
 * recording implementation, and these tests verify the parts that are genuinely
 * ours: the markup we build, the mode switching, the HTML we hand to the caller,
 * the token insertion, the paste handling, and the sanitisation of the result.
 *
 * Run with:  node test/editor.test.js
 */

import assert from 'node:assert/strict';
import { installDom, FakeNode, FakeTextNode, textOf } from './helpers/dom.mjs';

/* ----------------------------------------------------------- execCommand stub */

const commandLog = [];

/**
 * A stub that records commands and emulates the two behaviours the editor
 * depends on: insertText (for tokens) and insertHTML.
 */
function execCommandStub(command, _ui, value) {
  commandLog.push({ command, value });

  const selection = globalThis.window.getSelection?.();
  const target = selection?.anchorNode?.parentNode ?? globalThis.document.activeElement;

  if (command === 'insertText' && target instanceof FakeNode) {
    const text = new FakeTextNode(String(value ?? ''));
    target.append(text);
  }
  if (command === 'insertHTML' && target instanceof FakeNode) {
    const holder = globalThis.document.createElement('div');
    holder.innerHTML = String(value ?? '');
    target.append(...holder.children.map((child) => child));
  }
  return true;
}

const { document } = installDom({ execCommand: execCommandStub });

const { createEditor, PERSONALIZATION_TOKENS } = await import('../public/js/editor.js');

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
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** Build an editor and return it with convenient handles. */
function makeEditor(options = {}) {
  commandLog.length = 0;
  // Dialogs are appended to a shared root; clear it so each test sees only its own.
  const modalRoot = document.getElementById('modal-root');
  modalRoot.children.length = 0;

  const changes = [];
  const previews = [];
  const editor = createEditor({
    value: options.value ?? '',
    onChange: (html) => changes.push(html),
    onPreview: (html) => previews.push(html),
  });
  return {
    editor,
    changes,
    previews,
    surface: editor.node.querySelector('.editor-surface'),
    code: editor.node.querySelector('textarea.editor-code'),
    toolbar: editor.node.querySelector('.editor-toolbar'),
    get logs() {
      return commandLog;
    },
    /** Click a toolbar button by its visible label. */
    clickToolbar(label) {
      const button = editor.node
        .querySelectorAll('.editor-btn')
        .find((node) => node.innerHTML === label || node.textContent?.trim() === label);
      if (!button) throw new Error(`toolbar button "${label}" not found`);
      button.fire('mousedown');
      button.fire('click');
      return button;
    },
    selectValue(select, value) {
      select.value = value;
      select.fire('change');
    },
  };
}

console.log('\nMailBlast email editor\n');

/* ------------------------------------------------------------------ structure */

await test('creates a contenteditable surface plus an HTML source view', () => {
  const ui = makeEditor();
  assert.ok(ui.surface, 'surface missing');
  assert.ok(ui.code, 'code view missing');
  assert.equal(ui.surface.getAttribute('contenteditable'), 'true');
  assert.equal(ui.surface.style.display, '', 'surface should be visible');
  assert.equal(ui.code.style.display, 'none', 'code view should start hidden');
});
await test('starts in visual mode', () => {
  const ui = makeEditor();
  assert.equal(ui.editor.getMode(), 'visual');
});

await test('renders the initial value into the visual surface', () => {
  const ui = makeEditor({ value: '<p>Hello <strong>there</strong></p>' });
  assert.match(ui.surface.innerHTML, /Hello/);
  assert.match(ui.surface.innerHTML, /<strong>there<\/strong>/);
  assert.equal(textOf(ui.surface).includes('Hello there'), true);
});

await test('provides a toolbar with the core email formatting controls', () => {
  const ui = makeEditor();
  const labels = ui.toolbar.querySelectorAll('.editor-btn').map((b) => b.innerHTML);
  for (const label of ['<b>B</b>', '<i>I</i>', '<u>U</u>', '<s>S</s>', 'H1', 'H2', '¶', '•', '1.']) {
    assert.ok(labels.includes(label), `missing toolbar control ${label}`);
  }
});

await test('offers font family, font size and personalization menus', () => {
  const ui = makeEditor();
  const selects = ui.toolbar.querySelectorAll('select');
  assert.equal(selects.length, 3, `expected 3 menus, found ${selects.length}`);

  const labels = selects.flatMap((select) => select.children.map((option) => textOf(option)));
  assert.ok(labels.some((label) => /Arial/.test(label)), 'font family list missing');
  assert.ok(labels.some((label) => /Normal \(15px\)/.test(label)), 'font size list missing');
  assert.ok(labels.some((label) => /First name/.test(label)), 'personalization list missing');
});

await test('exposes the documented personalization tokens', () => {
  const tokens = PERSONALIZATION_TOKENS.map((entry) => entry.token);
  assert.deepEqual(tokens, ['{{name}}', '{{first_name}}', '{{last_name}}', '{{company}}', '{{email}}', '{{date}}']);
});

/* -------------------------------------------------------------- mode switching */

await test('switching to HTML source shows the code view and hides the toolbar', () => {
  const ui = makeEditor({ value: '<p>Hello</p>' });
  ui.editor.setMode('code');

  assert.equal(ui.editor.getMode(), 'code');
  assert.equal(ui.surface.style.display, 'none');
  assert.equal(ui.code.style.display, '');
  assert.equal(ui.toolbar.style.display, 'none', 'toolbar is meaningless in source mode');
  assert.match(ui.code.value, /Hello/, 'source view must contain the current markup');
});

await test('switching back to visual renders edited source into the surface', () => {
  const ui = makeEditor({ value: '<p>One</p>' });
  ui.editor.setMode('code');
  ui.code.value = '<p>Two <em>italic</em></p>';
  ui.code.fire('input');
  ui.editor.setMode('visual');

  assert.equal(ui.editor.getMode(), 'visual');
  assert.equal(ui.surface.style.display, '');
  assert.match(ui.surface.innerHTML, /Two/);
  assert.match(ui.surface.innerHTML, /<em>italic<\/em>/);
  assert.match(ui.editor.getHtml(), /Two/);
});

await test('the mode tabs reflect and drive the current mode', () => {
  const ui = makeEditor();
  const [visualTab, codeTab] = ui.editor.node.querySelectorAll('.editor-modebar .tab');

  assert.equal(visualTab.classList.contains('active'), true);

  codeTab.fire('click');
  assert.equal(codeTab.classList.contains('active'), true, 'code tab should activate');
  assert.equal(visualTab.classList.contains('active'), false, 'visual tab should deactivate');
  assert.equal(ui.editor.getMode(), 'code');

  visualTab.fire('click');
  assert.equal(ui.editor.getMode(), 'visual');
  assert.equal(visualTab.classList.contains('active'), true);
});

/* -------------------------------------------------------------------- commands */

await test('toolbar buttons invoke the matching document commands', () => {
  const ui = makeEditor();
  ui.surface.focus();

  ui.clickToolbar('<b>B</b>');
  ui.clickToolbar('<i>I</i>');
  ui.clickToolbar('<u>U</u>');
  ui.clickToolbar('H2');
  ui.clickToolbar('•');
  ui.clickToolbar('1.');

  const commands = ui.logs.map((entry) => entry.command);
  assert.ok(commands.includes('bold'), 'bold not issued');
  assert.ok(commands.includes('italic'), 'italic not issued');
  assert.ok(commands.includes('underline'), 'underline not issued');
  assert.ok(commands.includes('formatBlock'), 'heading not issued');
  assert.ok(commands.includes('insertUnorderedList'), 'bullet list not issued');
  assert.ok(commands.includes('insertOrderedList'), 'numbered list not issued');
});

await test('block formatting passes the right tag argument', () => {
  const ui = makeEditor();
  ui.clickToolbar('H2');
  const call = ui.logs.find((entry) => entry.command === 'formatBlock');
  assert.equal(String(call.value).toUpperCase(), 'H2');
});

await test('formatting is emitted as inline CSS, not legacy tags', () => {
  const ui = makeEditor();
  ui.clickToolbar('<b>B</b>');
  const styleCall = ui.logs.find((entry) => entry.command === 'styleWithCSS');
  assert.ok(styleCall, 'styleWithCSS must be enabled so email clients get inline styles');
  assert.equal(styleCall.value, true);
});

await test('clicking a toolbar button does not steal focus from the editor', () => {
  const ui = makeEditor();
  const button = ui.toolbar.querySelectorAll('.editor-btn')[0];
  const event = { type: 'mousedown' };
  const returned = button.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'mousedown must be prevented to preserve the selection');
  assert.equal(returned, false, 'a prevented event reports false, as in the DOM');
});

await test('font size is converted from the legacy font element to an inline pixel size', () => {
  const ui = makeEditor();
  const sizeSelect = ui.toolbar.querySelectorAll('select')[1];

  ui.selectValue(sizeSelect, '5');

  // execCommand('fontSize') takes a 1–7 key rather than a CSS length.
  const call = ui.logs.find((entry) => entry.command === 'fontSize');
  assert.equal(call.value, '5');

  // Whatever the browser leaves behind is rewritten to an inline pixel size.
  const holder = document.createElement('div');
  holder.innerHTML = '<p><font size="5">Big</font></p>';
  const normalised = holder.innerHTML.replace(
    /<font\s+size="?5"?[^>]*>([\s\S]*?)<\/font>/i,
    '<span style="font-size:22px">$1</span>',
  );
  assert.match(normalised, /font-size:22px/);
  assert.ok(!/font size=/.test(normalised), 'the legacy font element must not survive');
});

/* ---------------------------------------------------------------------- tokens */

await test('insertToken inserts the token as literal text', () => {
  const ui = makeEditor({ value: '<p></p>' });
  ui.surface.innerHTML = '<p>Hello </p>';
  ui.surface.focus();
  ui.editor.insertToken('{{first_name}}');

  assert.ok(
    ui.logs.some((entry) => entry.command === 'insertText' && entry.value === '{{first_name}}'),
    'the token should be inserted with insertText so it is not parsed as markup',
  );
});

await test('insertToken inserts into the source view when in HTML mode', () => {
  const ui = makeEditor({ value: '<p>Hi </p>' });
  ui.editor.setMode('code');
  ui.code.value = '<p>Hi </p>';
  ui.code.selectionStart = ui.code.selectionEnd = ui.code.value.length;

  ui.editor.insertToken('{{company}}');

  assert.match(ui.code.value, /\{\{company\}\}$/);
});

await test('insertToken reports the resulting HTML to the caller', () => {
  const ui = makeEditor({ value: '<p></p>' });
  ui.surface.innerHTML = '<p></p>';
  ui.surface.focus();
  ui.changes.length = 0;
  ui.editor.insertToken('{{name}}');
  assert.ok(ui.changes.length > 0, 'onChange should fire immediately after inserting a token');
});

/* ------------------------------------------------------------------ paste rules */

await test('pasting rich web HTML is converted to simple paragraphs', () => {
  const ui = makeEditor({ value: '<p></p>' });
  ui.surface.innerHTML = '<p></p>';
  ui.surface.focus();

  const clipboard = {
    getData: (type) =>
      type === 'text/html'
        ? '<div style="font-family:Comic Sans"><span style="color:red">Fancy</span></div>'
        : 'Plain one\n\nPlain two',
  };

  const event = { type: 'paste', clipboardData: clipboard };
  ui.surface.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true, 'the rich paste should be intercepted');
  const inserted = ui.logs.find((entry) => entry.command === 'insertHTML');
  assert.ok(inserted, 'paste should insert its own markup');
  assert.ok(!/Comic Sans/.test(String(inserted.value)), 'external styling must not be carried in');
  assert.match(String(inserted.value), /Plain one/);
  assert.match(String(inserted.value), /Plain two/);
  assert.match(String(inserted.value), /<p>/, 'paragraphs should be preserved');
});

await test('holding shift while pasting keeps the original formatting', () => {
  const ui = makeEditor({ value: '<p></p>' });
  ui.surface.innerHTML = '<p></p>';
  ui.surface.focus();

  const html = '<p><strong>Keep me bold</strong></p>';
  const event = {
    type: 'paste',
    shiftKey: true,
    clipboardData: { getData: (type) => (type === 'text/html' ? html : 'Keep me bold') },
    preventDefault() {},
  };
  ui.surface.dispatchEvent(event);

  const inserted = ui.logs.find((entry) => entry.command === 'insertHTML');
  assert.equal(String(inserted.value), html, 'shift-paste should pass the markup through');
});

await test('pasting plain text needs no interception', () => {
  const ui = makeEditor({ value: '<p></p>' });
  const event = {
    type: 'paste',
    clipboardData: { getData: (type) => (type === 'text/html' ? '' : 'just text') },
  };
  ui.surface.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, 'plain text should paste natively');
});

/* ------------------------------------------------------------------- change flow */

await test('typing reports changes to the caller, debounced', async () => {
  const ui = makeEditor({ value: '<p>Start</p>' });
  ui.surface.innerHTML = '<p>Changed</p>';
  ui.surface.fire('input');

  assert.equal(ui.changes.length, 0, 'changes should be debounced, not reported synchronously');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(ui.changes.length > 0, 'the change should be reported after the debounce');
  assert.match(ui.changes.at(-1), /Changed/);
});

await test('blurring flushes the pending change immediately', () => {
  const ui = makeEditor({ value: '<p>Start</p>' });
  ui.surface.innerHTML = '<p>Flushed</p>';
  ui.surface.fire('input');
  ui.surface.fire('blur');
  assert.ok(ui.changes.some((html) => /Flushed/.test(html)), 'blur should flush the change');
});

await test('setHtml replaces content and notifies once', () => {
  const ui = makeEditor({ value: '<p>Old</p>' });
  ui.changes.length = 0;
  ui.editor.setHtml('<h1>New</h1>');
  assert.match(ui.surface.innerHTML, /New/);
  assert.ok(!/Old/.test(ui.surface.innerHTML), 'old content should be replaced');
  assert.equal(ui.changes.length, 1, 'setHtml should report exactly one change');
  assert.match(ui.changes[0], /New/);
});

await test('getHtml returns the current markup in either mode', () => {
  const ui = makeEditor({ value: '<p>Visual</p>' });
  assert.match(ui.editor.getHtml(), /Visual/);

  ui.editor.setMode('code');
  ui.code.value = '<p>Source</p>';
  assert.match(ui.editor.getHtml(), /Source/);
});

await test('an empty editor still yields usable markup', () => {
  const ui = makeEditor({ value: '' });
  assert.equal(typeof ui.editor.getHtml(), 'string');
  assert.ok(ui.surface.innerHTML.length > 0, 'the surface should not be truly empty');
});

await test('a link can be inserted with a personalization token in the URL', async () => {
  const ui = makeEditor({ value: '<p></p>' });
  ui.surface.innerHTML = '<p></p>';
  ui.surface.focus();

  ui.clickToolbar('⛓');
  const modal = document.getElementById('modal-root');
  assert.ok(modal.querySelector('.modal'), 'the link dialog did not open');

  const inputs = modal.querySelectorAll('input');
  const urlInput = inputs.find((input) => (input.attributes.placeholder ?? '').includes('https://'));
  assert.ok(urlInput, 'URL field missing');

  // The token buttons should be offered for URL personalization.
  const tokenButton = modal.querySelectorAll('button.token').find((b) => textOf(b) === '{{first_name}}');
  assert.ok(tokenButton, 'a token button should be available in the link dialog');
  tokenButton.fire('click');
  assert.match(urlInput.value, /\{\{first_name\}\}/, 'the token should be appended to the URL');
});

await test('the link dialog rejects an empty URL', async () => {
  const ui = makeEditor({ value: '<p></p>' });
  ui.clickToolbar('⛓');
  const modal = document.getElementById('modal-root');
  const insert = modal
    .querySelectorAll('button.btn')
    .find((b) => textOf(b) === 'Insert link');
  assert.ok(insert, 'Insert link button missing');

  commandLog.length = 0;
  insert.fire('click');
  assert.ok(
    !commandLog.some((entry) => entry.command === 'createLink' || entry.command === 'insertHTML'),
    'no link should be created without a URL',
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
