/**
 * A small DOM implementation for testing the browser modules in Node.
 *
 * It is not a complete browser: it implements the subset the MailBlast views and
 * the email editor use — element creation, `innerHTML` parsing, class/tag/attribute
 * selectors, events, `style`, `dataset`, and the `contenteditable` surface (via an
 * injectable `execCommand`). That is enough to catch the failure mode that matters
 * most here: a render that throws, or produces the wrong structure, and would
 * otherwise show up as a blank screen in a real browser.
 */

/* ------------------------------------------------------------------- parsing */

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

/**
 * Parse an HTML string into nodes, appending them to `parent`.
 * Handles tags, attributes, comments, self-closing tags and text.
 */
export function parseHtml(html, parent, createElement, createTextNode) {
  const input = String(html ?? '');
  const stack = [parent];
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < input.length) {
    const lt = input.indexOf('<', i);

    if (lt === -1) {
      const text = input.slice(i);
      if (text) top().appendChild(createTextNode(decodeEntities(text)));
      break;
    }

    if (lt > i) {
      const text = input.slice(i, lt);
      if (text) top().appendChild(createTextNode(decodeEntities(text)));
    }

    // Comment
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }

    // Doctype / declaration
    if (input[lt + 1] === '!') {
      const end = input.indexOf('>', lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const gt = findTagEnd(input, lt);
    if (gt === -1) {
      const text = input.slice(lt);
      top().appendChild(createTextNode(decodeEntities(text)));
      break;
    }

    const rawTag = input.slice(lt + 1, gt).trim();
    i = gt + 1;

    // Closing tag
    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tagName.toLowerCase() === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceAt = body.search(/[\s/]/);
    const tag = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const attrText = spaceAt === -1 ? '' : body.slice(spaceAt);

    if (!tag) continue;

    const node = createElement(tag);
    applyAttributes(node, attrText);
    top().appendChild(node);

    if (VOID_ELEMENTS.has(tag) || selfClosing) continue;

    // Raw-text elements swallow everything until their closing tag.
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeAt = input.toLowerCase().indexOf(`</${tag}`, i);
      const raw = closeAt === -1 ? input.slice(i) : input.slice(i, closeAt);
      if (raw) node.appendChild(createTextNode(raw));
      if (closeAt === -1) break;
      i = closeAt;
      continue;
    }

    stack.push(node);
  }

  return parent;
}

/** Find the '>' that ends a tag, skipping '>' inside quoted attribute values. */
function findTagEnd(input, start) {
  let quote = null;
  for (let i = start + 1; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

function applyAttributes(node, attrText) {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(attrText)) !== null) {
    const name = match[1].toLowerCase();
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    node.setAttribute(name, value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      node.dataset[key] = value;
    }
  }

  // Mirror the properties the DOM reflects from attributes. `lib.js` decides how
  // to set a property with `key in node`, so these must exist on parsed nodes.
  if (node.hasAttribute('value')) node.value = node.getAttribute('value');
  if (node.hasAttribute('checked')) node.checked = true;
  if (node.hasAttribute('disabled')) node.disabled = true;
  if (node.hasAttribute('selected')) node.selected = true;
  if (node.hasAttribute('id')) node.id = node.getAttribute('id');
  if (node.hasAttribute('class')) node.className = node.getAttribute('class');
  if (node.hasAttribute('contenteditable')) node.contentEditable = node.getAttribute('contenteditable');
}

const ENTITIES = {
  '&nbsp;': '\u00a0',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

export function decodeEntities(text) {
  return String(text).replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity);
}

export function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------------------------------------------------------------- nodes */

/**
 * A `style` object that behaves like a real CSSStyleDeclaration: reading an
 * unset property yields `''`, and assigning a string normalises to a string.
 * Plain `{}` would give `undefined`, which diverges from browsers in ways that
 * silently break assertions.
 */
export function createStyle() {
  return new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'setProperty') return (name, value) => { target[name] = String(value); };
        if (prop === 'getPropertyValue') return (name) => target[name] ?? '';
        if (prop === 'removeProperty') return (name) => { delete target[name]; };
        if (typeof prop === 'symbol') return target[prop];
        return target[prop] ?? '';
      },
      set(target, prop, value) {
        target[prop] = value === null || value === undefined ? '' : String(value);
        return true;
      },
    },
  );
}

export class FakeClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...names) {
    for (const name of names) if (name) this.set.add(name);
    this.sync();
  }
  remove(...names) {
    for (const name of names) this.set.delete(name);
    this.sync();
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    this.sync();
    return on;
  }
  sync() {
    this.node._className = [...this.set].join(' ');
  }
}

export class FakeTextNode {
  constructor(text) {
    this._text = String(text);
    this.children = [];
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
  }
  get innerText() {
    return this._text;
  }
  get outerHTML() {
    return escapeText(this._text);
  }
}

/** Serialise a node subtree back to HTML (enough for assertions). */
export function serialize(node) {
  if (node instanceof FakeTextNode) return escapeText(node._text);
  const attrs = Object.entries(node.attributes)
    .map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${String(value).replace(/"/g, '&quot;')}"`))
    .join('');
  const tag = node.tagName.toLowerCase();
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs} />`;
  return `<${tag}${attrs}>${node.children.map(serialize).join('')}</${tag}>`;
}

export class FakeNode {
  constructor(tag = 'div', { document: doc } = {}) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.attributes = {};
    this.style = createStyle();
    this.listeners = {};
    this._text = '';
    this._className = '';
    this.checked = false;
    this.disabled = false;
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._document = doc ?? null;
    this._classList = new FakeClassList(this);

    // `dataset` and `data-*` attributes are two views of the same state.
    const dataStore = {};
    Object.defineProperty(this, 'dataset', {
      get: () => dataStore,
      set: (value) => {
        for (const key of Object.keys(dataStore)) delete dataStore[key];
        if (value && typeof value === 'object') {
          for (const [key, val] of Object.entries(value)) {
            dataStore[key] = String(val);
            this.attributes[`data-${String(key).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`] = String(val);
          }
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  get ownerDocument() {
    return this._document;
  }

  get className() {
    return this._className;
  }
  set className(value) {
    this._className = String(value ?? '');
    this._classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }
  get classList() {
    return this._classList;
  }

  get id() {
    return this.attributes.id ?? '';
  }
  set id(value) {
    this.attributes.id = String(value);
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent ?? '').join('');
    return this._text;
  }
  set textContent(value) {
    this.children.length = 0;
    this._text = String(value ?? '');
  }

  get innerText() {
    return collectText(this);
  }

  get innerHTML() {
    return this.children.map(serialize).join('');
  }
  set innerHTML(value) {
    this.children.length = 0;
    this._innerHTMLSet = String(value);
    const doc = this._document;
    parseHtml(value, this, (tag) => new FakeNode(tag, { document: doc }), (text) => new FakeTextNode(text));
  }

  get outerHTML() {
    return serialize(this);
  }

  get contentEditable() {
    return this.attributes.contenteditable ?? 'inherit';
  }
  set contentEditable(value) {
    this.attributes.contenteditable = String(value);
  }

  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (node === null || node === undefined || node === false) continue;
      const child = typeof node === 'string' ? new FakeTextNode(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
    return this;
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(node) {
    node.parentNode = this;
    this.children.unshift(node);
  }
  insertBefore(node, reference) {
    const index = this.children.indexOf(reference);
    node.parentNode = this;
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[String(name)] = String(value);
  }
  getAttribute(name) {
    return this.attributes[String(name)] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[String(name)];
  }
  hasAttribute(name) {
    return Object.hasOwn(this.attributes, String(name));
  }

  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }
  dispatchEvent(event) {
    // Dispatch the caller's own object, as a real DOM does, so that assertions
    // like `event.defaultPrevented` are observable after dispatch.
    const own = Object.getOwnPropertyDescriptor(event, 'target');
    if (!own) {
      try {
        Object.defineProperty(event, 'target', {
          value: this,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch {
        /* a real Event's target is getter-only; leave it alone */
      }
    }

    if (typeof event.defaultPrevented !== 'boolean') {
      event.defaultPrevented = false;
    }
    if (typeof event.preventDefault !== 'function') {
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
    } else {
      const originalPrevent = event.preventDefault.bind(event);
      event.preventDefault = () => {
        event.defaultPrevented = true;
        originalPrevent();
      };
    }
    if (typeof event.stopPropagation !== 'function') {
      event.stopPropagation = () => {};
    }

    for (const handler of [...(this.listeners[event.type] ?? [])]) handler(event);
    return !event.defaultPrevented;
  }

  /** Test helper: simulate a user interaction. */
  fire(type, extra = {}) {
    const event = { type, target: this, ...extra };
    this.dispatchEvent(event);
    return event;
  }
  focus() {
    if (this._document) this._document.activeElement = this;
  }
  blur() {
    this.fire('blur');
  }
  click() {
    this.fire('click');
  }
  select() {}

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const part of String(selector).split(',').map((s) => s.trim()).filter(Boolean)) {
      const spaceParts = part.split(/\s+/).filter(Boolean);
      const head = spaceParts.pop();
      const ancestorSelector = spaceParts.join(' ');

      const scopes = [];
      if (ancestorSelector) {
        const findAncestors = (node) => {
          for (const child of node.children) {
            if (child instanceof FakeNode && matchesSelector(child, ancestorSelector)) scopes.push(child);
            if (child instanceof FakeNode) findAncestors(child);
          }
        };
        findAncestors(this);
      } else {
        scopes.push(this);
      }

      for (const scope of scopes) {
        const collect = (node) => {
          for (const child of node.children) {
            if (child instanceof FakeNode) {
              if (matchesSelector(child, head)) results.push(child);
              collect(child);
            }
          }
        };
        collect(scope);
      }
    }
    return [...new Set(results)];
  }
}

/** Readable text of a subtree, with a space between adjacent elements. */
export function collectText(node) {
  if (node instanceof FakeTextNode) return node._text;
  if (!node.children?.length) return node._text ?? '';
  return node.children.map((child) => collectText(child)).join(' ');
}

/**
 * Whitespace-normalised visible text of a subtree. Hidden subtrees are pruned,
 * matching what a browser would render. Use this rather than reimplementing text
 * extraction per test file — getting it subtly wrong silently breaks assertions.
 */
export function textOf(node) {
  if (!node) return '';
  const parts = [];
  const visit = (current) => {
    if (current instanceof FakeTextNode) {
      parts.push(current._text);
      return;
    }
    if (current.style?.display === 'none') return;
    if (current.children?.length) {
      for (const child of current.children) visit(child);
      return;
    }
    if (current._text) parts.push(current._text);
  };
  visit(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** True when the node or an ancestor is hidden with display:none. */
export function isHidden(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.style?.display === 'none') return true;
  }
  return false;
}

export function matchesSelector(node, selector) {
  // Attribute selector: [name] or [name="value"]
  const attr = selector.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
  if (attr) {
    const name = attr[1];
    const value = attr[2] ?? attr[3] ?? attr[4];
    return value === undefined ? node.hasAttribute(name) : node.getAttribute(name) === value;
  }

  const parts = selector.match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)(#[\w-]+)?$/);
  if (!parts) return false;
  const [, tag, classes, id] = parts;

  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (id && node.getAttribute('id') !== id.slice(1)) return false;
  if (classes) {
    for (const cls of classes.split('.').filter(Boolean)) {
      if (!node.classList.contains(cls)) return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------- document */

/**
 * Install globals (document, window, localStorage, ...) and return handles.
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.stubs] Extra routes are handled by the caller.
 * @param {(command:string, value?:any)=>void} [options.execCommand] Optional override.
 */
export function installDom({ execCommand } = {}) {
  const body = new FakeNode('body');
  const documentStub = {
    body,
    activeElement: null,
    createElement: (tag) => new FakeNode(tag, { document: documentStub }),
    createTextNode: (text) => new FakeTextNode(text),
    getElementById: (id) => documentStub.body.querySelectorAll(`[id="${id}"]`)[0] ?? null,
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    addEventListener() {},
    removeEventListener() {},
    execCommand: execCommand ?? (() => true),
    queryCommandState: () => false,
    queryCommandValue: () => '',
    queryCommandSupported: () => true,
  };

  // The app shell expects these hosts to exist.
  for (const id of ['nav', 'main', 'toasts', 'modal-root']) {
    const node = documentStub.createElement(id === 'nav' ? 'nav' : 'div');
    node.setAttribute('id', id);
    body.append(node);
  }

  const timers = {
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: (fn, delay) => setTimeout(fn, delay ?? 0),
    clearTimeout: (id) => clearTimeout(id),
  };

  globalThis.document = documentStub;
  globalThis.Node = class {
    static [Symbol.hasInstance](value) {
      return value instanceof FakeNode || value instanceof FakeTextNode;
    }
  };
  globalThis.window = {
    location: { hash: '#/compose', origin: 'http://localhost:3210' },
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => null,
    ...timers,
  };
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) {
      return this.store.get(key) ?? null;
    },
    setItem(key, value) {
      this.store.set(key, String(value));
    },
    removeItem(key) {
      this.store.delete(key);
    },
  };
  globalThis.EventSource = class {
    addEventListener() {}
    close() {}
  };
  globalThis.DOMParser = class {
    parseFromString(html) {
      const doc = new FakeNode('div');
      parseHtml(html, doc, (tag) => new FakeNode(tag), (text) => new FakeTextNode(text));
      return {
        querySelector: (selector) => doc.querySelector(selector),
        querySelectorAll: (selector) => doc.querySelectorAll(selector),
        body: doc,
      };
    }
  };
  globalThis.FileReader = class {
    readAsText() {}
  };

  return { document: documentStub, body };
}

/* ----------------------------------------------------------------- fetch stub */

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Record every request and dispatch it to a handler map. */
export function installFetch(handler, calls = []) {
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url), 'http://localhost');
    const call = {
      route: parsed.pathname,
      method: options.method ?? 'GET',
      query: parsed.searchParams,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    calls.push(call);
    const response = await handler(call);
    if (response instanceof Response) return response;
    return jsonResponse(response ?? {});
  };
  return calls;
}
