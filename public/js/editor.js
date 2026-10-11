import { el, mount, clear, openModal, toast } from './lib.js';

/**
 * A WYSIWYG email editor.
 *
 * The editing surface is a `contenteditable` element, so the author sees the
 * message as a recipient would. `document.execCommand` drives formatting: it is
 * formally deprecated but remains the only cross-browser way to do this without
 * a large dependency, and it is universally supported in practice.
 *
 * Output is deliberately kept email-safe: formatting is emitted as inline CSS
 * (`styleWithCSS`), and everything is passed through the server-side sanitiser
 * before it is stored or sent. A raw HTML view is still available for anyone who
 * wants to hand-edit the markup, but it is no longer the primary surface.
 */

const FONT_FAMILIES = [
  { label: 'Default (system sans)', value: '' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: 'Trebuchet MS, Tahoma, sans-serif' },
  { label: 'Georgia', value: 'Georgia, Times, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

/** execCommand('fontSize') only accepts 1–7; map those to email-safe pixel sizes. */
const FONT_SIZES = [
  { key: '2', label: 'Small (13px)', px: '13px' },
  { key: '3', label: 'Normal (15px)', px: '15px' },
  { key: '4', label: 'Large (18px)', px: '18px' },
  { key: '5', label: 'Heading (22px)', px: '22px' },
  { key: '6', label: 'Title (28px)', px: '28px' },
  { key: '7', label: 'Display (36px)', px: '36px' },
];

const SWATCHES = [
  '#1b1f24', '#5b6472', '#8b95a3', '#ffffff',
  '#d93a3a', '#e8590c', '#b9810c', '#17a673',
  '#2f6df6', '#7048e8', '#c2255c', '#0b7285',
];

export const PERSONALIZATION_TOKENS = [
  { token: '{{name}}', label: 'Full name' },
  { token: '{{first_name}}', label: 'First name' },
  { token: '{{last_name}}', label: 'Last name' },
  { token: '{{company}}', label: 'Company' },
  { token: '{{email}}', label: 'Email' },
  { token: '{{date}}', label: 'Today' },
];

/**
 * Turn execCommand's `<font size="N">` output into inline pixel styles, which
 * mail clients honour far more reliably than a legacy `font` element.
 */
function normaliseFontSizes(html) {
  return String(html ?? '').replace(
    /<font\s+size="?([1-7])"?([^>]*)>([\s\S]*?)<\/font>/gi,
    (all, size, rest, inner) => {
      const found = FONT_SIZES.find((entry) => entry.key === size);
      if (!found) return all;
      const stripped = String(rest).replace(/\s*style="([^"]*)"/i, (_m, existing) => ` style="${existing}"`);
      return `<span style="font-size:${found.px}">${inner}</span>`;
    },
  );
}

/** Strip the wrapper the editor adds around inline formatting. */
function tidyHtml(html) {
  let output = normaliseFontSizes(html);
  // `execCommand` sometimes wraps a single block in a redundant div.
  output = output.replace(/<div><br\s*\/?><\/div>/gi, '');
  return output;
}

/**
 * @param {object} options
 * @param {string} options.value            Initial HTML.
 * @param {(html:string)=>void} options.onChange  Called (debounced) on edits.
 * @param {(html:string)=>void} [options.onPreview] Called for live preview updates.
 * @param {number} [options.height]         Editor height in px.
 */
export function createEditor({ value = '', onChange, onPreview, height = 420 } = {}) {
  let mode = 'visual'; // 'visual' | 'code'
  let suppress = false;
  let previewTimer = null;

  /* ------------------------------------------------------------ edit surface */

  const surface = el('div.editor-surface', {
    contenteditable: 'true',
    spellcheck: 'true',
    style: { minHeight: `${height}px` },
  });
  surface.innerHTML = value || '<p><br /></p>';

  const codeArea = el('textarea.editor-code', {
    spellcheck: 'false',
    style: { minHeight: `${height}px`, display: 'none' },
  });
  codeArea.value = value || '';

  /* ---------------------------------------------------------------- plumbing */

  function currentHtml() {
    return mode === 'visual' ? tidyHtml(surface.innerHTML) : codeArea.value;
  }

  function emit({ immediate = false } = {}) {
    if (suppress) return;
    const html = currentHtml();
    if (immediate) {
      onChange?.(html);
      onPreview?.(html);
      return;
    }
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      onChange?.(html);
      onPreview?.(html);
    }, 350);
  }

  /** Run a document command against the visual surface. */
  function exec(command, argument = null) {
    if (mode !== 'visual') switchTo('visual');
    surface.focus();
    try {
      document.execCommand('styleWithCSS', false, true);
    } catch {
      /* older engines only; formatting still applies */
    }
    document.execCommand(command, false, argument ?? undefined);
    emit();
    refreshToolbarState();
  }

  function switchTo(next) {
    if (next === mode) return;
    if (next === 'code') {
      codeArea.value = tidyHtml(surface.innerHTML);
      surface.style.display = 'none';
      codeArea.style.display = '';
      codeArea.focus();
    } else {
      surface.innerHTML = codeArea.value || '<p><br /></p>';
      codeArea.style.display = 'none';
      surface.style.display = '';
      surface.focus();
    }
    mode = next;
    modeButtons.visual.classList.toggle('active', mode === 'visual');
    modeButtons.code.classList.toggle('active', mode === 'code');
    toolbar.style.display = mode === 'visual' ? '' : 'none';
    codeHint.style.display = mode === 'visual' ? 'none' : '';
    emit({ immediate: true });
  }

  /* ----------------------------------------------------------------- toolbar */

  const toolbar = el('div.editor-toolbar');

  function button({ label, title, command, argument, isActive, onClick, className = '' }) {
    const node = el(`button.editor-btn${className ? `.${className}` : ''}`, {
      type: 'button',
      title,
      // Keep focus (and therefore the selection) in the editor.
      onmousedown: (event) => event.preventDefault(),
      onclick: () => (onClick ? onClick() : exec(command, argument)),
    });
    node.innerHTML = label;
    if (isActive) node.dataset.activeWhen = isActive;
    return node;
  }

  const group = (...children) => el('div.editor-group', null, children);

  const historyGroup = group(
    button({ label: '↶', title: 'Undo (Ctrl+Z)', command: 'undo' }),
    button({ label: '↷', title: 'Redo (Ctrl+Shift+Z)', command: 'redo' }),
  );

  const inlineGroup = group(
    button({ label: '<b>B</b>', title: 'Bold (Ctrl+B)', command: 'bold', isActive: 'bold' }),
    button({ label: '<i>I</i>', title: 'Italic (Ctrl+I)', command: 'italic', isActive: 'italic' }),
    button({ label: '<u>U</u>', title: 'Underline (Ctrl+U)', command: 'underline', isActive: 'underline' }),
    button({ label: '<s>S</s>', title: 'Strikethrough', command: 'strikeThrough', isActive: 'strikeThrough' }),
    button({ label: 'x²', title: 'Superscript', command: 'superscript' }),
  );

  const blockGroup = group(
    button({ label: 'H1', title: 'Heading 1', command: 'formatBlock', argument: 'H1', isActive: 'h1' }),
    button({ label: 'H2', title: 'Heading 2', command: 'formatBlock', argument: 'H2', isActive: 'h2' }),
    button({ label: 'H3', title: 'Heading 3', command: 'formatBlock', argument: 'H3', isActive: 'h3' }),
    button({ label: '¶', title: 'Paragraph', command: 'formatBlock', argument: 'P', isActive: 'p' }),
    button({ label: '❝', title: 'Quote', command: 'formatBlock', argument: 'BLOCKQUOTE', isActive: 'blockquote' }),
  );

  const listGroup = group(
    button({ label: '•', title: 'Bulleted list', command: 'insertUnorderedList', isActive: 'insertUnorderedList' }),
    button({ label: '1.', title: 'Numbered list', command: 'insertOrderedList', isActive: 'insertOrderedList' }),
    button({ label: '⇥', title: 'Increase indent', command: 'indent' }),
    button({ label: '⇤', title: 'Decrease indent', command: 'outdent' }),
  );

  const alignGroup = group(
    button({ label: '⯇', title: 'Align left', command: 'justifyLeft', isActive: 'justifyLeft' }),
    button({ label: '≡', title: 'Align centre', command: 'justifyCenter', isActive: 'justifyCenter' }),
    button({ label: '⯈', title: 'Align right', command: 'justifyRight', isActive: 'justifyRight' }),
  );

  /* ------------------------------------------------ font family & size menus */

  const familySelect = el('select.editor-select', {
    title: 'Font family',
    onmousedown: (event) => event.stopPropagation(),
    onchange: (event) => {
      const family = event.target.value;
      if (!family) return;
      exec('fontName', family);
    },
  }, [
    el('option', { value: '', text: 'Font…' }),
    ...FONT_FAMILIES.map((entry) => el('option', { value: entry.value, text: entry.label })),
  ]);

  const sizeSelect = el('select.editor-select', {
    title: 'Font size',
    onchange: (event) => {
      const key = event.target.value;
      if (!key) return;
      exec('fontSize', key);
      // execCommand emits <font size="N">; convert it to an inline pixel style.
      surface.innerHTML = normaliseFontSizes(surface.innerHTML);
      emit();
      event.target.value = '';
    },
  }, [
    el('option', { value: '', text: 'Size…' }),
    ...FONT_SIZES.map((entry) => el('option', { value: entry.key, text: entry.label })),
  ]);

  /* -------------------------------------------------------------- colour menu */

  function colourMenu(title, command) {
    const input = el('input', {
      type: 'color',
      class: 'editor-colour',
      value: '#1b1f24',
      title,
      onmousedown: (event) => event.stopPropagation(),
      oninput: (event) => {
        // Preserve the selection: apply without stealing focus first.
        if (mode !== 'visual') switchTo('visual');
        surface.focus();
        document.execCommand(command, false, event.target.value);
        emit();
      },
    });

    const wrapper = el('div.editor-colour-wrap', null, [
      el('button.editor-btn', {
        type: 'button',
        title,
        onmousedown: (event) => event.preventDefault(),
        onclick: () => input.click(),
      }, command === 'foreColor' ? 'A' : '▨'),
      input,
    ]);

    const swatchRow = el('div.editor-swatches');
    for (const colour of SWATCHES) {
      swatchRow.append(
        el('button.editor-swatch', {
          type: 'button',
          title: colour,
          style: { background: colour },
          onmousedown: (event) => event.preventDefault(),
          onclick: () => {
            if (mode !== 'visual') switchTo('visual');
            surface.focus();
            document.execCommand(command, false, colour);
            input.value = colour;
            emit();
          },
        }),
      );
    }

    // Swatches apply directly; the colour input covers anything else.
    return el('div', null, [wrapper, swatchRow]);
  }

  /* -------------------------------------------------------------------- links */

  function insertLink() {
    const selection = window.getSelection?.();
    const selectedText = selection?.toString() ?? '';

    const urlInput = el('input', { type: 'text', placeholder: 'https://example.com' });
    const textInput = el('input', { type: 'text', value: selectedText, placeholder: 'Link text' });
    const tokenBar = el('div.token-bar');

    for (const token of PERSONALIZATION_TOKENS.slice(0, 4)) {
      tokenBar.append(
        el('button.token', {
          type: 'button',
          text: token.token,
          title: `Insert ${token.label} into the URL`,
          onmousedown: (event) => event.preventDefault(),
          onclick: () => {
            const start = urlInput.selectionStart ?? urlInput.value.length;
            urlInput.value = `${urlInput.value.slice(0, start)}${token.token}${urlInput.value.slice(urlInput.selectionEnd ?? start)}`;
            urlInput.focus();
            urlInput.selectionStart = urlInput.selectionEnd = start + token.token.length;
          },
        }),
      );
    }

    const dialog = openModal({
      title: 'Insert link',
      size: 'narrow',
      body: el('div', null, [
        el('div.field', null, [el('label', { text: 'Link text' }), textInput]),
        el('div.field', null, [
          el('label', { text: 'URL' }),
          urlInput,
          el('div.help', { text: 'Use https:// for web links, or mailto: for an email address.' }),
        ]),
        el('div.field', null, [el('label', { text: 'Insert a personalization token' }), tokenBar]),
      ]),
      footer: [
        el('button.btn', {
          type: 'button',
          onclick: () => {
            dialog.close();
            exec('unlink');
          },
        }, 'Remove link'),
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: () => {
            const url = urlInput.value.trim();
            const text = textInput.value.trim();
            if (!url) {
              toast('Enter a URL for the link.', 'error');
              return;
            }
            dialog.close();
            if (mode !== 'visual') switchTo('visual');
            surface.focus();
            if (text && text !== window.getSelection?.().toString()) {
              document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`);
            } else {
              document.execCommand('createLink', false, url);
            }
            emit();
          },
        }, 'Insert link'),
      ],
    });

    urlInput.focus();
  }

  /* ------------------------------------------------------------------ buttons */

  const alignOrListExtra = group(
    button({ label: '—', title: 'Horizontal rule', command: 'insertHorizontalRule' }),
    button({ label: '⛓', title: 'Insert link', onClick: insertLink }),
    button({ label: '⌫', title: 'Clear formatting', command: 'removeFormat' }),
  );

  const tokenMenu = (() => {
    const select = el('select.editor-select', {
      title: 'Insert a personalization token',
      onchange: (event) => {
        const token = event.target.value;
        if (!token) return;
        insertToken(token);
        event.target.value = '';
      },
    }, [
      el('option', { value: '', text: 'Personalize…' }),
      ...PERSONALIZATION_TOKENS.map((entry) => el('option', { value: entry.token, text: `${entry.label}  ${entry.token}` })),
    ]);
    return select;
  })();

  /** Insert text (usually a token) at the caret, in either mode. */
  function insertToken(text) {
    if (mode === 'code') {
      const start = codeArea.selectionStart ?? codeArea.value.length;
      const end = codeArea.selectionEnd ?? start;
      codeArea.value = `${codeArea.value.slice(0, start)}${text}${codeArea.value.slice(end)}`;
      codeArea.focus();
      codeArea.selectionStart = codeArea.selectionEnd = start + text.length;
    } else {
      surface.focus();
      // insertText keeps the token literal rather than parsing it as markup.
      document.execCommand('insertText', false, text);
    }
    emit({ immediate: true });
    toast(`Inserted ${text}`, 'info', 1600);
  }

  mount(
    toolbar,
    historyGroup,
    inlineGroup,
    blockGroup,
    listGroup,
    alignGroup,
    group(familySelect, sizeSelect, tokenMenu),
    group(colourMenu('Text colour', 'foreColor'), colourMenu('Highlight', 'hiliteColor')),
    alignOrListExtra,
  );

  /* ---------------------------------------------------------- mode switcher */

  const modeButtons = {
    visual: el('button.tab.active', {
      type: 'button',
      onclick: () => switchTo('visual'),
    }, 'Visual'),
    code: el('button.tab', {
      type: 'button',
      onclick: () => switchTo('code'),
    }, 'HTML source'),
  };

  const modeBar = el('div.editor-modebar', null, [
    el('div.tabs', { style: { margin: '0', border: '0' } }, [modeButtons.visual, modeButtons.code]),
    el('div.spacer', { style: { flex: '1' } }),
    el('span.muted', { style: { fontSize: '11.5px' } }, 'Formatting is stored as inline CSS for email clients'),
  ]);

  const codeHint = el('div.alert.alert-info', {
    style: { display: 'none', marginTop: '8px' },
    html: 'Editing raw HTML. Switch back to <strong>Visual</strong> to see the message as the recipient will. Scripts and event handlers are stripped before sending.',
  });

  /* ---------------------------------------------------------- toolbar state */

  function refreshToolbarState() {
    if (mode !== 'visual') return;
    for (const node of toolbar.querySelectorAll('[data-active-when]')) {
      const command = node.dataset.activeWhen;
      let active = false;
      try {
        active = document.queryCommandState(command);
      } catch {
        active = false;
      }
      node.classList.toggle('active', Boolean(active));
    }
  }

  surface.addEventListener('input', () => emit());
  surface.addEventListener('keyup', refreshToolbarState);
  surface.addEventListener('mouseup', refreshToolbarState);
  surface.addEventListener('blur', () => emit({ immediate: true }));
  codeArea.addEventListener('input', () => emit());

  // Paste as plain text by default: pasted web markup wrecks email layout.
  surface.addEventListener('paste', (event) => {
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!html) return; // plain text pastes fine natively
    event.preventDefault();

    // Honour an explicit "keep formatting" modifier.
    if (event.shiftKey) {
      document.execCommand('insertHTML', false, html);
    } else {
      // Split into paragraphs so line breaks survive.
      const paragraphs = text
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);
      const markup = paragraphs.length
        ? paragraphs.map((block) => `<p>${block.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br />')}</p>`).join('')
        : '';
      document.execCommand('insertHTML', false, markup);
    }
    emit();
  });

  /* --------------------------------------------------------------- shortcuts */

  surface.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;

    const key = event.key.toLowerCase();
    if (key === 'k') {
      event.preventDefault();
      insertLink();
      return;
    }
    if (key === 'b' || key === 'i' || key === 'u') {
      // Let the browser handle it, then resync.
      setTimeout(() => {
        emit();
        refreshToolbarState();
      }, 0);
    }
  });

  /* ------------------------------------------------------------------- public */

  const node = el('div.editor', null, [modeBar, toolbar, codeHint, surface, codeArea]);

  return {
    node,
    /** Current HTML, exactly as it would be sent. */
    getHtml: () => currentHtml(),
    /** Replace the content (e.g. after loading a template). */
    setHtml(html) {
      suppress = true;
      surface.innerHTML = html || '<p><br /></p>';
      codeArea.value = html || '';
      suppress = false;
      emit({ immediate: true });
    },
    insertToken,
    focus: () => (mode === 'visual' ? surface : codeArea).focus(),
    getMode: () => mode,
    setMode: switchTo,
  };
}
