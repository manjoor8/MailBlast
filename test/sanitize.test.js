/**
 * Email sanitiser tests.
 *
 * The sanitiser is the last thing an email passes through before it reaches a
 * mail server, so it is exercised as a pure function: no server, no database,
 * no network. Every case asserts the exact markup that comes back out.
 *
 * Run with:  node test/sanitize.test.js
 */

import assert from 'node:assert/strict';

const {
  sanitizeEmailHtml,
  sanitizeMessage,
  decodeEntities,
  default: sanitizeDefault,
} = await import('../server/sanitize.js');

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

console.log('\nMailBlast sanitizer tests\n');

/* ------------------------------------------------------ dangerous elements */

await test('strips script tags together with their content', () => {
  assert.equal(
    sanitizeEmailHtml('<p>before</p><script>alert("xss")</script><p>after</p>'),
    '<p>before</p><p>after</p>',
  );
});

await test('strips a script that only loads a remote file', () => {
  assert.equal(sanitizeEmailHtml('hello<script src="https://evil.example/x.js"></script>'), 'hello');
});

await test('strips script tags whatever their case and spacing', () => {
  assert.equal(sanitizeEmailHtml('<SCRIPT type="text/javascript">alert(1)</SCRIPT >'), '');
});

await test('strips style blocks and the CSS inside them', () => {
  assert.equal(sanitizeEmailHtml('<style>p { color: red }</style><p>text</p>'), '<p>text</p>');
});

await test('strips iframes', () => {
  assert.equal(sanitizeEmailHtml('<iframe src="https://evil.example"></iframe><p>text</p>'), '<p>text</p>');
});

await test('strips objects and embeds', () => {
  assert.equal(sanitizeEmailHtml('<object data="evil.swf"></object><p>text</p>'), '<p>text</p>');
  assert.equal(sanitizeEmailHtml('<embed src="evil.swf"><p>text</p>'), '<p>text</p>');
});

await test('strips a form with everything inside it', () => {
  assert.equal(
    sanitizeEmailHtml('<p>text</p><form action="https://evil.example"><input type="text" name="email"></form>'),
    '<p>text</p>',
  );
});

await test('strips stray input elements', () => {
  assert.equal(sanitizeEmailHtml('<input type="hidden" name="x" value="1"><p>text</p>'), '<p>text</p>');
});

await test('strips meta, link and base tags', () => {
  assert.equal(
    sanitizeEmailHtml(
      '<meta charset="utf-8"><link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/"><p>text</p>',
    ),
    '<p>text</p>',
  );
});

await test('strips svg with its content', () => {
  assert.equal(sanitizeEmailHtml('<svg onload="alert(1)"><circle cx="1" /></svg>text'), 'text');
});

/* -------------------------------------------------- inline event handlers */

await test('strips an inline event handler', () => {
  assert.equal(sanitizeEmailHtml('<p onclick="alert(1)">hi</p>'), '<p>hi</p>');
});

await test('strips several event handlers from one tag', () => {
  assert.equal(sanitizeEmailHtml('<p onmouseover="alert(1)" onfocus="alert(2)">hi</p>'), '<p>hi</p>');
});

await test('strips event handlers regardless of case', () => {
  assert.equal(sanitizeEmailHtml('<p ONCLICK="alert(1)" OnMouseOver="alert(2)">hi</p>'), '<p>hi</p>');
});

await test('strips onload from an allowed container', () => {
  assert.equal(sanitizeEmailHtml('<div onload="alert(1)">hi</div>'), '<div>hi</div>');
});

await test('strips a handler from an allowed tag but keeps the tag', () => {
  assert.equal(
    sanitizeEmailHtml('<img src="https://example.com/logo.png" onerror="alert(1)" alt="Logo">'),
    '<img src="https://example.com/logo.png" alt="Logo" />',
  );
});

await test('strips an unquoted event handler', () => {
  assert.equal(
    sanitizeEmailHtml('<img src="https://example.com/logo.png" onerror=alert(1)>'),
    '<img src="https://example.com/logo.png" />',
  );
});

/* ------------------------------------------------------------- URL schemes */

await test('removes a javascript: URL from href', () => {
  const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
  assert.equal(out, '<a>click</a>');
  assert.ok(!out.includes('href'));
});

await test('removes javascript: URLs written with escapes or stray whitespace', () => {
  const attempts = ['JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'jav&#x61;script:alert(1)'];
  for (const href of attempts) {
    assert.equal(sanitizeEmailHtml(`<a href="${href}">click</a>`), '<a>click</a>', href);
  }
});

await test('removes a vbscript: URL from href', () => {
  assert.equal(sanitizeEmailHtml('<a href="vbscript:msgbox(1)">click</a>'), '<a>click</a>');
});

await test('removes data: URLs from href and src', () => {
  assert.equal(
    sanitizeEmailHtml('<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>'),
    '<a>click</a>',
  );
  assert.equal(sanitizeEmailHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="logo">'), '<img alt="logo" />');
});

await test('keeps https, http, mailto, tel, cid, anchor and relative URLs', () => {
  const safe = [
    'https://example.com/page?x=1',
    'http://example.com/page',
    'mailto:hi@example.com',
    'tel:+15551234567',
    'cid:inline-image-1',
    '#section',
    '/unsubscribe?id=7',
  ];
  for (const href of safe) {
    const out = sanitizeEmailHtml(`<a href="${href}">link</a>`);
    assert.ok(out.includes(`href="${href}"`), `expected ${href} to survive, got ${out}`);
    assert.ok(
      out.includes('rel="noopener noreferrer"') && out.includes('target="_blank"'),
      `expected safe link semantics for ${href}`,
    );
  }
});

await test('keeps a cid: src on an image', () => {
  assert.equal(sanitizeEmailHtml('<img src="cid:inline-1" alt="Logo">'), '<img src="cid:inline-1" alt="Logo" />');
});

/* ----------------------------------------------------------- inline styles */

await test('keeps a style attribute on an allowed tag', () => {
  assert.equal(
    sanitizeEmailHtml('<p style="font-size: 16px; color: #336699; text-align: center;">Hi</p>'),
    '<p style="font-size: 16px; color: #336699; text-align: center;">Hi</p>',
  );
});

await test('collapses whitespace inside a kept style attribute', () => {
  assert.equal(
    sanitizeEmailHtml('<p style="color:  red;\n  font-size: 12px">Hi</p>'),
    '<p style="color: red; font-size: 12px">Hi</p>',
  );
});

await test('drops style declarations that can execute or fetch', () => {
  const unsafe = [
    'width: expression(alert(1))',
    'background: url(https://evil.example/track.png)',
    'background-image: URL(https://evil.example/track.png)',
    'color: javascript:alert(1)',
    'behavior: url(#default#time2)',
    "color: red; @import 'https://evil.example/x.css'",
    '-moz-binding: url(evil.xml#x)',
  ];
  for (const style of unsafe) {
    assert.equal(sanitizeEmailHtml(`<p style="${style}">x</p>`), '<p>x</p>', style);
  }
});

await test('keeps the other attributes when only the style is dropped', () => {
  assert.equal(
    sanitizeEmailHtml('<p class="lead" style="background: url(track.png)" align="center">x</p>'),
    '<p class="lead" align="center">x</p>',
  );
});

/* ------------------------------------------------------- legitimate markup */

await test('keeps the markup a newsletter is built from', () => {
  assert.equal(
    sanitizeEmailHtml(
      '<h1>Title</h1><h2>Sub</h2><h3>Small</h3>'
        + '<p><strong>bold</strong> <em>italic</em> <u>underline</u></p>'
        + '<ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li></ol>'
        + '<blockquote>quote</blockquote><br><hr>'
        + '<div align="center"><span style="color: #ff0000;">red</span></div>',
    ),
    '<h1>Title</h1><h2>Sub</h2><h3>Small</h3>'
      + '<p><strong>bold</strong> <em>italic</em> <u>underline</u></p>'
      + '<ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li></ol>'
      + '<blockquote>quote</blockquote><br /><hr />'
      + '<div align="center"><span style="color: #ff0000;">red</span></div>',
  );
});

await test('keeps table markup and its presentational attributes', () => {
  const table = '<table border="0" cellpadding="4" cellspacing="0" role="presentation" width="600">'
    + '<thead><tr><th scope="col" colspan="2">Head</th></tr></thead>'
    + '<tbody><tr><td colspan="2" align="center" valign="top">Cell</td></tr></tbody></table>';
  assert.equal(sanitizeEmailHtml(table), table);
});

await test('keeps font tags and their presentational attributes', () => {
  assert.equal(
    sanitizeEmailHtml('<font color="#ff0000" face="Arial" size="3">Hi</font>'),
    '<font color="#ff0000" face="Arial" size="3">Hi</font>',
  );
});

await test('keeps img src, alt and dimensions', () => {
  assert.equal(
    sanitizeEmailHtml('<img src="https://example.com/logo.png" alt="Logo" width="120" height="40" border="0">'),
    '<img src="https://example.com/logo.png" alt="Logo" width="120" height="40" border="0" />',
  );
});

await test('drops attributes that are not on the allowlist', () => {
  assert.equal(
    sanitizeEmailHtml('<p id="x" data-token="y" contenteditable="true" class="lead">Hi</p>'),
    '<p class="lead">Hi</p>',
  );
});

/* ------------------------------------------------------------ unknown tags */

await test('unwraps an unknown tag and keeps its text', () => {
  assert.equal(sanitizeEmailHtml('<article>hello</article>'), 'hello');
});

await test('unwraps nested unknown tags', () => {
  assert.equal(sanitizeEmailHtml('<main><article><section>nested</section></article></main>'), 'nested');
});

await test('unwraps an unknown tag but keeps allowed markup inside it', () => {
  assert.equal(sanitizeEmailHtml('<section><p>kept</p></section>'), '<p>kept</p>');
});

await test('unwraps an unknown tag without letting its handler through', () => {
  assert.equal(sanitizeEmailHtml('<article onclick="alert(1)" class="x">hello</article>'), 'hello');
});

/* ------------------------------------------------------- links and comments */

await test('adds rel and target to a surviving link', () => {
  assert.equal(
    sanitizeEmailHtml('<a href="https://example.com">Example</a>'),
    '<a href="https://example.com" rel="noopener noreferrer" target="_blank">Example</a>',
  );
});

await test('overrides a link target and rel that the editor wrote', () => {
  assert.equal(
    sanitizeEmailHtml('<a href="https://example.com" target="_self" rel="opener">Example</a>'),
    '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a>',
  );
});

await test('leaves a link with no href alone', () => {
  assert.equal(sanitizeEmailHtml('<a name="anchor">text</a>'), '<a name="anchor">text</a>');
});

await test('removes HTML comments', () => {
  assert.equal(
    sanitizeEmailHtml('<p>before</p><!-- <script>alert(1)</script> --><p>after</p>'),
    '<p>before</p><p>after</p>',
  );
});

await test('removes a conditional comment with the markup it hides', () => {
  assert.equal(sanitizeEmailHtml('<!--[if IE]><script>alert(1)</script><![endif]--><p>keep</p>'), '<p>keep</p>');
});

/* --------------------------------------------------------- personalisation */

await test('leaves personalization tokens untouched', () => {
  assert.equal(
    sanitizeEmailHtml('<p>Hi {{first_name}}, order {{order_id}} has shipped.</p>'),
    '<p>Hi {{first_name}}, order {{order_id}} has shipped.</p>',
  );
});

await test('keeps a token inside a link URL and its text', () => {
  assert.equal(
    sanitizeEmailHtml('<a href="https://example.com/confirm?u={{email}}">Confirm {{first_name}}</a>'),
    '<a href="https://example.com/confirm?u={{email}}" rel="noopener noreferrer" target="_blank">Confirm {{first_name}}</a>',
  );
});

await test('keeps a token inside an attribute value', () => {
  assert.equal(
    sanitizeEmailHtml('<img src="cid:{{cid}}" alt="{{first_name}}">'),
    '<img src="cid:{{cid}}" alt="{{first_name}}" />',
  );
});

/* -------------------------------------------------------------- no content */

await test('returns an empty string for null, undefined and empty input', () => {
  assert.equal(sanitizeEmailHtml(null), '');
  assert.equal(sanitizeEmailHtml(undefined), '');
  assert.equal(sanitizeEmailHtml(''), '');
});

await test('returns an empty string when only dangerous markup was given', () => {
  assert.equal(sanitizeEmailHtml('<script>alert(1)</script>'), '');
  assert.equal(sanitizeEmailHtml('<!-- nothing here -->'), '');
});

/* -------------------------------------------------------------- idempotency */

await test('sanitising already sanitised HTML changes nothing', () => {
  const messy = '<div><h1>Hi {{first_name}}</h1><p onclick="alert(1)" style="color: #333333;">Body</p>'
    + '<script>alert(1)</script><a href="https://example.com/page" target="_top">Link</a>'
    + '<img src="https://example.com/logo.png" onerror="alert(1)" alt="Logo"></div>';
  const once = sanitizeEmailHtml(messy);
  assert.ok(once.includes('{{first_name}}'));
  assert.equal(sanitizeEmailHtml(once), once);
});

await test('escapes a raw ampersand in a URL exactly once', () => {
  assert.equal(
    sanitizeEmailHtml('<a href="https://example.com/unsubscribe?u={{email}}&id=7">Unsubscribe</a>'),
    '<a href="https://example.com/unsubscribe?u={{email}}&amp;id=7" rel="noopener noreferrer" target="_blank">Unsubscribe</a>',
  );
});

// Regression: attributes are decoded before they are re-encoded, so an "&amp;"
// the browser already wrote must not come back out as "&amp;amp;". Getting that
// wrong also breaks the idempotency guarantee above for any attribute holding
// an entity — the round-trip cases at the bottom of this file lock it in.
await test('leaves an ampersand the source already escaped alone', () => {
  assert.equal(
    sanitizeEmailHtml('<a href="https://example.com/unsubscribe?u={{email}}&amp;id=7">Unsubscribe</a>'),
    '<a href="https://example.com/unsubscribe?u={{email}}&amp;id=7" rel="noopener noreferrer" target="_blank">Unsubscribe</a>',
  );
});

/* ---------------------------------------------------------- realistic email */

await test('a realistic table-based newsletter survives intact', () => {
  const email = '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center">'
    + '<tr><td style="padding: 24px; font-size: 16px; color: #333333;">'
    + '<h1 style="font-size: 24px; color: #0b5fff;">Hello {{first_name}}</h1>'
    + '<p style="text-align: left;">Your order <strong>{{order_id}}</strong> is on its way.</p>'
    + '<p><a href="https://example.com/orders/{{order_id}}">Track your order</a></p>'
    + '<img src="https://cdn.example.com/logo.png" alt="MailBlast" width="160">'
    + '<p style="font-size: 12px; color: #888888;"><a href="/unsubscribe">Unsubscribe</a></p>'
    + '</td></tr></table>';

  const out = sanitizeEmailHtml(email);

  assert.ok(out.startsWith('<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center">'));
  assert.ok(out.includes('<td style="padding: 24px; font-size: 16px; color: #333333;">'));
  assert.ok(out.includes('<h1 style="font-size: 24px; color: #0b5fff;">Hello {{first_name}}</h1>'));
  assert.ok(out.includes('Your order <strong>{{order_id}}</strong> is on its way.'));
  assert.ok(out.includes('<a href="https://example.com/orders/{{order_id}}" rel="noopener noreferrer" target="_blank">Track your order</a>'));
  assert.ok(out.includes('<img src="https://cdn.example.com/logo.png" alt="MailBlast" width="160" />'));
  assert.ok(out.includes('<a href="/unsubscribe" rel="noopener noreferrer" target="_blank">Unsubscribe</a>'));
  assert.ok(out.endsWith('</table>'));
  assert.equal(out.match(/<table/g).length, out.match(/<\/table>/g).length);
  assert.equal(out.match(/<td/g).length, out.match(/<\/td>/g).length);
  assert.equal(out.match(/<tr/g).length, out.match(/<\/tr>/g).length);
});

/* ----------------------------------------------------------- sanitizeMessage */

await test('sanitizeMessage returns the clean HTML and its text alternative', () => {
  const result = sanitizeMessage({
    html: '<p>Hi {{first_name}}</p><script>alert(1)</script>',
    toText: (clean) => clean.replace(/<[^>]+>/g, ''),
  });
  assert.equal(result.html, '<p>Hi {{first_name}}</p>');
  assert.equal(result.text, 'Hi {{first_name}}');
});

await test('sanitizeMessage returns an empty text when no converter is given', () => {
  const result = sanitizeMessage({ html: '<p>Hi</p>' });
  assert.equal(result.html, '<p>Hi</p>');
  assert.equal(result.text, '');
});

await test('the default export sanitises like the named export', () => {
  assert.equal(sanitizeDefault('<script>alert(1)</script><p>ok</p>'), '<p>ok</p>');
});

/* ------------------------------------------------- entity round-trip (fix) */

await test('does not double-escape an href that already holds an entity', () => {
  const out = sanitizeEmailHtml('<a href="https://example.com/u?u={{email}}&amp;id=7">Unsubscribe</a>');
  assert.equal(
    out,
    '<a href="https://example.com/u?u={{email}}&amp;id=7" rel="noopener noreferrer" target="_blank">Unsubscribe</a>',
  );
  assert.ok(!out.includes('&amp;amp;'), 'the href was escaped twice');
  assert.ok(out.includes('{{email}}'), 'the personalization token was lost');
});

await test('escapes a raw ampersand in a URL once and keeps it stable', () => {
  const input = '<a href="https://example.com/u?b=1&c=2">x</a>';
  const once = sanitizeEmailHtml(input);
  assert.equal(
    once,
    '<a href="https://example.com/u?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">x</a>',
  );
  assert.ok(!once.includes('&amp;amp;'), 'the raw ampersand was escaped twice');
  assert.equal(sanitizeEmailHtml(once), once);
});

await test('round-trips an entity in an img alt', () => {
  const out = sanitizeEmailHtml('<img src="https://x/y.png" alt="Tom &amp; Jerry">');
  assert.equal(out, '<img src="https://x/y.png" alt="Tom &amp; Jerry" />');
  assert.ok(!out.includes('&amp;amp;'), 'the alt text was escaped twice');
});

await test('round-trips an entity in a mailto body', () => {
  const out = sanitizeEmailHtml('<a href="mailto:a@b.c?subject=Hi&amp;body=There">Mail</a>');
  assert.equal(
    out,
    '<a href="mailto:a@b.c?subject=Hi&amp;body=There" rel="noopener noreferrer" target="_blank">Mail</a>',
  );
  assert.ok(out.includes('&amp;body='), 'the mailto body separator was lost');
  assert.ok(!out.includes('&amp;amp;'), 'the mailto body was escaped twice');
});

/* --------------------------------------------------- idempotency regression */

await test('sanitising an entity-bearing attribute twice changes nothing', () => {
  const inputs = [
    '<a href="https://example.com/u?u={{email}}&amp;id=7">Unsubscribe</a>',
    '<a href="https://example.com/u?b=1&c=2">x</a>',
    '<img src="https://x/y.png" alt="Tom &amp; Jerry">',
    '<a href="mailto:a@b.c?subject=Hi&amp;body=There">Mail</a>',
  ];
  for (const input of inputs) {
    const once = sanitizeEmailHtml(input);
    assert.equal(sanitizeEmailHtml(once), once, input);
  }
});

await test('sanitising a newsletter with a query-string unsubscribe link twice changes nothing', () => {
  const email = '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center">'
    + '<tr><td style="padding: 24px; font-size: 16px; color: #333333;">'
    + '<h1 style="font-size: 24px;">Hello {{first_name}}</h1>'
    + '<p><a href="https://example.com/u?u={{email}}&amp;id=7&amp;t=3">Unsubscribe</a></p>'
    + '<img src="https://cdn.example.com/logo.png" alt="Tom &amp; Jerry" width="160">'
    + '<p><a href="mailto:hi@example.com?subject=Hi&amp;body=There">Reply</a></p>'
    + '</td></tr></table>';

  const once = sanitizeEmailHtml(email);
  assert.ok(once.includes('href="https://example.com/u?u={{email}}&amp;id=7&amp;t=3"'));
  assert.ok(!once.includes('&amp;amp;'), 'an entity was escaped twice');
  assert.equal(sanitizeEmailHtml(once), once);
});

/* -------------------------------------------- obfuscated scheme hardening */

await test('rejects a scheme written with a decimal character reference', () => {
  const out = sanitizeEmailHtml('<a href="java&#115;cript:alert(1)">x</a>');
  assert.equal(out, '<a>x</a>');
  assert.ok(!out.includes('href'), 'the obfuscated scheme survived');
  assert.ok(!out.toLowerCase().includes('javascript:'), 'javascript: leaked into the output');
});

await test('rejects a scheme written with a hex character reference', () => {
  const out = sanitizeEmailHtml('<a href="jav&#x61;script:alert(1)">x</a>');
  assert.equal(out, '<a>x</a>');
  assert.ok(!out.includes('href'), 'the obfuscated scheme survived');
  assert.ok(!out.toLowerCase().includes('javascript:'), 'javascript: leaked into the output');
});

await test('rejects a scheme padded with leading whitespace', () => {
  const out = sanitizeEmailHtml('<a href="  javascript:alert(1)">x</a>');
  assert.equal(out, '<a>x</a>');
  assert.ok(!out.includes('href'), 'the padded scheme survived');
  assert.ok(!out.toLowerCase().includes('javascript:'), 'javascript: leaked into the output');
});

await test('keeps the link text when an obfuscated scheme is rejected', () => {
  assert.equal(sanitizeEmailHtml('<a href="java&#115;cript:alert(1)">Click me</a>'), '<a>Click me</a>');
});

/* ----------------------------------------------------------- decodeEntities */

await test('decodeEntities decodes named entities', () => {
  assert.equal(decodeEntities('&amp;'), '&');
  assert.equal(decodeEntities('&lt;'), '<');
  assert.equal(decodeEntities('&gt;'), '>');
  assert.equal(decodeEntities('&quot;'), '"');
  assert.equal(decodeEntities('&nbsp;'), '\u00a0');
  assert.equal(decodeEntities('&mdash;'), '—');
  assert.equal(decodeEntities('&hellip;'), '…');
});

await test('decodeEntities decodes decimal character references', () => {
  assert.equal(decodeEntities('&#39;'), "'");
  assert.equal(decodeEntities('&#8212;'), '—');
});

await test('decodeEntities decodes hexadecimal character references', () => {
  assert.equal(decodeEntities('&#x27;'), "'");
  assert.equal(decodeEntities('&#x2014;'), '—');
});

await test('decodeEntities leaves an unknown entity untouched', () => {
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

await test('decodeEntities leaves a bare ampersand untouched', () => {
  assert.equal(decodeEntities('&'), '&');
  assert.equal(decodeEntities('Tom & Jerry'), 'Tom & Jerry');
});

await test('decodeEntities leaves an out-of-range reference untouched', () => {
  assert.doesNotThrow(() => decodeEntities('&#9999999999;'));
  assert.equal(decodeEntities('&#9999999999;'), '&#9999999999;');
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;');
});

await test('decodeEntities decodes only one level', () => {
  assert.equal(decodeEntities('&amp;#106;'), '&#106;');
  assert.notEqual(decodeEntities('&amp;#106;'), 'j');
  assert.equal(decodeEntities('&#106;'), 'j');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
