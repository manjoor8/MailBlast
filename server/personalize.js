/**
 * Personalization engine.
 *
 * Templates may use any of these placeholders (all case-insensitive,
 * whitespace inside the braces is ignored):
 *
 *   {{name}} {{first_name}} {{last_name}} {{email}} {{company}} {{date}}
 *
 * `{{first_name}}` is the first whitespace-separated word of the full name.
 */

export const TOKENS = [
  { token: '{{name}}', label: 'Full name', example: 'Ada Lovelace' },
  { token: '{{first_name}}', label: 'First name', example: 'Ada' },
  { token: '{{last_name}}', label: 'Last name', example: 'Lovelace' },
  { token: '{{email}}', label: 'Email address', example: 'ada@example.com' },
  { token: '{{company}}', label: 'Company', example: 'Analytical Engines' },
  { token: '{{date}}', label: 'Today', example: new Date().toISOString().slice(0, 10) },
];

const TOKEN_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

export function buildContext(contact = {}, extra = {}) {
  const name = String(contact.name ?? '').trim();
  const parts = name.split(/\s+/).filter(Boolean);

  return {
    name: name || String(contact.email ?? '').split('@')[0] || 'there',
    first_name: parts[0] || String(contact.email ?? '').split('@')[0] || 'there',
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : '',
    email: String(contact.email ?? '').trim(),
    company: String(contact.company ?? '').trim(),
    date: new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    ...extra,
  };
}

/** Replace every known token in a string. Unknown tokens are left untouched. */
export function renderString(template, context) {
  return String(template ?? '').replace(TOKEN_RE, (match, rawKey) => {
    const key = String(rawKey).toLowerCase();
    if (!(key in context)) return match;
    const value = context[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Render subject + HTML body. When `personalize` is false the raw template is
 * returned untouched, so the exact same bytes go to every recipient.
 */
export function renderMessage({ subject, html, contact, personalize = true, extra = {} }) {
  if (!personalize) {
    return { subject: String(subject ?? ''), html: String(html ?? '') };
  }
  const context = buildContext(contact, extra);
  return {
    subject: renderString(subject, context),
    html: renderString(html, context),
  };
}

/** List the tokens actually used in a template (for UI warnings). */
export function detectTokens(...templates) {
  const found = new Set();
  for (const template of templates) {
    for (const match of String(template ?? '').matchAll(TOKEN_RE)) {
      found.add(String(match[1]).toLowerCase());
    }
  }
  return [...found];
}

/* ------------------------------------------------------------ html → text */

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
};

/**
 * A deliberately small HTML → text converter used for the optional plain-text
 * alternative part. It keeps link targets and block structure readable.
 */
export function htmlToText(html) {
  let out = String(html ?? '');

  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  out = out.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, text) => {
      const label = text.replace(/<[^>]+>/g, '').trim();
      if (!label) return href;
      return label === href ? href : `${label} <${href}>`;
    },
  );
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, '\n');
  out = out.replace(/<li\b[^>]*>/gi, '  • ');
  out = out.replace(/<hr\b[^>]*>/gi, '\n----------\n');
  out = out.replace(/<[^>]+>/g, '');
  out = out.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  out = out.replace(/[ \t\f\v\u00a0]+/g, ' ');
  out = out.replace(/ *\n */g, '\n');
  out = out.replace(/\n{3,}/g, '\n\n');
  // Removing tags leaves a space before trailing punctuation: "docs <url> ."
  out = out.replace(/ +([.,;:!?)\]])/g, '$1');

  return out.trim();
}

/** Rough guard so a template is never sent completely un-personalized. */
export function hasPlaceholder(value) {
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(String(value ?? ''));
}
