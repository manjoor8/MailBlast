/**
 * Email-safe HTML sanitiser.
 *
 * A visual editor produces whatever the browser's `execCommand` generates, which
 * can include scripts, event handlers, remote `<iframe>`s and other things that
 * have no business in an email. Everything that leaves for a mail server — and
 * everything rendered into a preview iframe — passes through here.
 *
 * The allowlist is deliberately the subset of HTML that mail clients actually
 * render. Unknown tags are unwrapped (their text is kept) rather than deleted,
 * so content is never silently lost.
 */

/** Tags whose entire content must be removed, not unwrapped. */
const DROP_WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'link',
  'meta',
  'base',
  'title',
  'head',
  'noscript',
  'svg',
  'math',
  'template',
  'audio',
  'video',
  'canvas',
  'dialog',
];

/** Tags permitted in the output. */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col',
  'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul',
]);

/** Tags that may legitimately be empty (self-closing / void). */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);

/**
 * Attributes permitted per tag, plus a global set.
 * Keep this tight: mail clients ignore most CSS anyway, and inline styles are the
 * only reliable way to style email.
 */
const GLOBAL_ATTRS = new Set(['style', 'class', 'title', 'dir', 'lang', 'align', 'valign', 'width', 'height', 'bgcolor']);
const TAG_ATTRS = {
  a: new Set(['href', 'target', 'rel', 'name']),
  img: new Set(['src', 'alt', 'border', 'hspace', 'vspace']),
  table: new Set(['cellpadding', 'cellspacing', 'border', 'role', 'summary']),
  td: new Set(['colspan', 'rowspan', 'nowrap']),
  th: new Set(['colspan', 'rowspan', 'nowrap', 'scope']),
  font: new Set(['color', 'face', 'size']),
  ol: new Set(['start', 'type']),
  ul: new Set(['type']),
};

const SAFE_URL = /^(https?:|mailto:|tel:|cid:|#|\/)/i;

/** Style declarations that can execute or fetch, and must never survive. */
const UNSAFE_STYLE = /(expression\s*\(|javascript:|vbscript:|behavior\s*:|@import|-moz-binding|url\s*\()/i;

/** Named entities we round-trip. Anything else is left as written. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  times: '×',
  laquo: '«',
  raquo: '»',
  bull: '•',
  dagger: '†',
  sect: '§',
  para: '¶',
};

const ENTITY_RE = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi;

/**
 * Decode the entity references we recognise.
 *
 * Required before re-encoding: a browser serialises `&` as `&amp;`, so attribute
 * values arriving from the editor are already escaped. Encoding those again would
 * turn `&amp;` into `&amp;amp;` — which corrupts every query string and `mailto:`
 * body, and makes sanitising twice differ from sanitising once.
 */
export function decodeEntities(value) {
  return String(value).replace(ENTITY_RE, (whole, hex, decimal, named) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (decimal) {
      const code = Number.parseInt(decimal, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const replacement = NAMED_ENTITIES[String(named).toLowerCase()];
    return replacement === undefined ? whole : replacement;
  });
}

/**
 * Encode a value for use inside a double-quoted attribute, exactly once.
 * Input is decoded first so the operation is idempotent.
 */
function encodeAttribute(value) {
  return decodeEntities(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Encode text content (no quote handling needed). */
function encodeText(value) {
  return decodeEntities(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Remove whole elements (tag + content) for tags we never want. */
function stripDangerousElements(html) {
  let output = html;
  for (const tag of DROP_WITH_CONTENT) {
    // Paired form, non-greedy, case-insensitive, dotall.
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    output = output.replace(paired, '');
    // Unclosed/self-closing form.
    output = output.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  // Comments can hide conditional-script tricks.
  output = output.replace(/<!--[\s\S]*?-->/g, '');
  return output;
}

function cleanAttributes(tag, attrString) {
  const kept = [];
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = attrRe.exec(attrString)) !== null) {
    const rawName = match[1];
    const name = rawName.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';

    // Event handlers and anything not explicitly allowed are dropped.
    if (name.startsWith('on')) continue;
    if (name === 'srcdoc' || name === 'formaction' || name === 'xlink:href') continue;

    const perTag = TAG_ATTRS[tag];
    if (!GLOBAL_ATTRS.has(name) && !(perTag && perTag.has(name))) continue;

    if (name === 'style') {
      if (UNSAFE_STYLE.test(value)) continue;
      // Normalise whitespace but otherwise trust the editor's inline CSS.
      kept.push(`style="${value.replace(/\s+/g, ' ').trim().replace(/"/g, '')}"`);
      continue;
    }

    if (name === 'href' || name === 'src') {
      // Decode before the scheme check so `java&#115;cript:` cannot slip through.
      const trimmed = decodeEntities(value).trim();
      if (!SAFE_URL.test(trimmed)) continue;
      kept.push(`${name}="${encodeAttribute(trimmed)}"`);
      continue;
    }

    if (name === 'target') {
      // Anything but _blank would escape our own UI on click.
      kept.push('target="_blank"');
      continue;
    }

    if (name === 'rel') {
      kept.push('rel="noopener noreferrer"');
      continue;
    }

    kept.push(`${name}="${encodeAttribute(value)}"`);
  }

  // Any link that survives gets safe rel/target semantics.
  if (tag === 'a' && kept.some((attr) => attr.startsWith('href='))) {
    if (!kept.some((attr) => attr.startsWith('rel='))) kept.push('rel="noopener noreferrer"');
    if (!kept.some((attr) => attr.startsWith('target='))) kept.push('target="_blank"');
  }

  return kept.length ? ` ${kept.join(' ')}` : '';
}

/**
 * Sanitise a full or fragment HTML document.
 *
 * @param {string} html
 * @returns {string}
 */
export function sanitizeEmailHtml(html) {
  if (!html) return '';

  let output = stripDangerousElements(String(html));

  // Rewrite every remaining tag: keep allowed ones (attributes cleaned),
  // unwrap everything else so its text content survives.
  output = output.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g, (_all, closing, rawTag, attrString, selfClosing) => {
    const tag = String(rawTag).toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      // Drop the tag but keep the content.
      return '';
    }
    if (closing) return `</${tag}>`;
    if (VOID_TAGS.has(tag) || selfClosing) return `<${tag}${cleanAttributes(tag, attrString)} />`;

    return `<${tag}${cleanAttributes(tag, attrString)}>`;
  });

  // Collapse the empty paragraphs a contenteditable leaves behind.
  output = output.replace(/(<p[^>]*>\s*(<br\s*\/?>|&nbsp;|\u00a0)*\s*<\/p>){3,}/gi, '<p><br /></p>');
  output = output.replace(/[ \t]+$/gm, '');

  return output.trim();
}

/**
 * Sanitise and return both the HTML and a plain-text alternative.
 * Kept here so callers do not have to remember to sanitise before converting.
 */
export function sanitizeMessage({ html, toText }) {
  const clean = sanitizeEmailHtml(html);
  return { html: clean, text: typeof toText === 'function' ? toText(clean) : '' };
}

export default sanitizeEmailHtml;
