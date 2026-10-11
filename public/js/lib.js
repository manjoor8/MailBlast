/* Shared browser helpers: tiny DOM builder, fetch wrapper, formatting, toasts. */

/* --------------------------------------------------------------- DOM build */

/**
 * el('div.card', { onclick }, [children])
 * The tag string supports `tag.class1.class2#id` shorthand.
 */
export function el(spec, props = null, children = null) {
  const [head, ...rest] = String(spec).split('#');
  const [tag, ...classes] = head.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (rest.length) node.id = rest.join('#');

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = `${node.className} ${value}`.trim();
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') {
        // Write real data-* attributes so selectors like [data-x] always match.
        for (const [dataKey, dataValue] of Object.entries(value)) {
          const attr = `data-${String(dataKey).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
          node.setAttribute(attr, String(dataValue));
          if (node.dataset) node.dataset[dataKey] = String(dataValue);
        }
      } else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && key !== 'list' && typeof value !== 'object') {
        try {
          node[key] = value;
        } catch {
          node.setAttribute(key, String(value));
        }
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  parent.append(children instanceof Node ? children : document.createTextNode(String(children)));
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** Escape text for safe interpolation into innerHTML. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* -------------------------------------------------------------------- fetch */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const options = { method, signal, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(path, options);
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const message = (payload && payload.error) || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}

export const get = (path, options) => api(path, { ...options, method: 'GET' });
export const post = (path, body, options) => api(path, { ...options, method: 'POST', body });
export const put = (path, body, options) => api(path, { ...options, method: 'PUT', body });
export const del = (path, options) => api(path, { ...options, method: 'DELETE' });

/* ------------------------------------------------------------------- toasts */

let toastHost = null;

export function toast(message, kind = 'info', timeout = 4200) {
  toastHost = toastHost ?? document.getElementById('toasts');
  if (!toastHost) return;
  const node = el(`div.toast.${kind}`, { text: message });
  toastHost.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, timeout);
}

/* ---------------------------------------------------------------- formatting */

export function formatDate(value, { withTime = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const opts = { year: 'numeric', month: 'short', day: '2-digit' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString(undefined, opts);
}

export function relativeTime(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const units = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) {
      const value2 = Math.round(diff / ms);
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-value2, unit);
    }
  }
  return 'just now';
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Debounce that also exposes .cancel(). */
export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/* -------------------------------------------------------------------- modal */

export function openModal({ title, body, footer, size = '' }) {
  const root = document.getElementById('modal-root');
  const modal = el(`div.modal${size ? `.${size}` : ''}`);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };

  modal.append(
    el('div.card-head', null, [
      el('h2', { text: title }),
      el('div.spacer'),
      el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: close, title: 'Close' }, '✕'),
    ]),
    el('div.modal-body', null, body),
  );
  if (footer) modal.append(el('div.modal-foot', null, footer));

  const backdrop = el('div.modal-backdrop', {
    onclick: (event) => {
      if (event.target === backdrop) close();
    },
  }, modal);

  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, modal };
}

/* ------------------------------------------------------------------ iframes */

/**
 * Render untrusted HTML into an iframe via srcdoc with a strict CSP so previews
 * cannot run scripts or phone home.
 */
export function renderHtmlIntoFrame(iframe, html) {
  const csp = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:;";
  iframe.setAttribute('sandbox', '');
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"></head><body style="margin:0;padding:14px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b1f24;">${html ?? ''}</body></html>`;
  return iframe;
}

export function autoGrowFrame(iframe, max = 600, min = 200) {
  iframe.addEventListener('load', () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const height = Math.min(max, Math.max(min, doc.documentElement.scrollHeight + 28));
      iframe.style.height = `${height}px`;
    } catch {
      /* cross-origin guard; sandboxed srcdoc stays same-origin in practice */
    }
  });
}
