import { el, mount, get, toast } from './lib.js';
import { renderCompose } from './views/compose.js';
import { renderDrafts } from './views/drafts.js';
import { renderContacts } from './views/contacts.js';
import { renderSent } from './views/sent.js';
import { renderSettings } from './views/settings.js';

/* -------------------------------------------------------------- global state */

export const store = {
  settings: null,
  tags: [],
  health: null,
  listeners: new Set(),
};

export function emit() {
  for (const listener of store.listeners) {
    try {
      listener(store);
    } catch (err) {
      console.error(err);
    }
  }
}

export async function refreshSettings() {
  store.settings = await get('/api/settings');
  emit();
  return store.settings;
}

export async function refreshTags() {
  const data = await get('/api/contacts/tags');
  store.tags = data.tags ?? [];
  emit();
  return store.tags;
}

export async function refreshHealth() {
  store.health = await get('/api/health');
  updateBadges();
  emit();
  return store.health;
}

function updateBadges() {
  const contacts = document.getElementById('nav-contacts');
  const sent = document.getElementById('nav-sent');
  const badge = document.getElementById('transport-badge');
  if (contacts) contacts.textContent = store.health?.counts?.contacts ?? 0;
  if (sent) sent.textContent = store.health?.counts?.sent ?? 0;

  if (!badge || !store.health) return;
  const { transport, configured } = store.health;
  const kind = configured ? (transport.kind === 'capture' ? 'warn' : 'ok') : 'bad';
  mount(
    badge,
    el(`span.dot.dot-${kind}`),
    el('span', { text: configured ? transport.label : 'No mail server configured' }),
  );
}

/* ------------------------------------------------------------------- routing */

const ROUTES = {
  compose: { title: 'Compose', render: renderCompose },
  drafts: { title: 'Drafts', render: renderDrafts },
  contacts: { title: 'Contacts', render: renderContacts },
  sent: { title: 'Sent history', render: renderSent },
  settings: { title: 'Settings', render: renderSettings },
};

const cache = new Map();
let currentRoute = null;
let currentHashValue = '';

function parsedHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { route: ROUTES[path] ? path : 'compose', query: new URLSearchParams(query) };
}

function currentHash() {
  return parsedHash().route;
}

function setActiveNav(route) {
  for (const link of document.querySelectorAll('#nav a')) {
    link.classList.toggle('active', link.dataset.route === route);
  }
}

async function navigate() {
  const { route, query } = parsedHash();

  // Compose can be opened at a specific draft (#/compose?draft=3). That is a
  // different view of the same route, so the cached node must not be reused.
  const signature = `${route}?${query.toString()}`;
  if (signature === currentHashValue) return;
  currentHashValue = signature;
  currentRoute = route;
  setActiveNav(route);

  const main = document.getElementById('main');
  mount(main, el('div.loading', null, [el('span.spinner'), ' Loading…']));

  const { render } = ROUTES[route];
  let node = query.toString() ? null : cache.get(route);

  if (!node) {
    try {
      node = await render();
    } catch (err) {
      console.error(err);
      node = el('div.alert.alert-error', { text: `Could not load this page: ${err.message}` });
    }
    // Only cache plain visits; a query-specific render must not stick.
    if (!query.toString()) cache.set(route, node);
  }

  mount(main, node);
  document.title = `${ROUTES[route].title} · MailBlast`;
  node.dispatchEvent(new CustomEvent('route:enter', { bubbles: false }));
}

/** Force a re-render of a route the next time it is shown (used after imports). */
export function invalidate(route) {
  if (!route) cache.clear();
  else cache.delete(route);
}

window.addEventListener('hashchange', navigate);

(async function boot() {
  try {
    await Promise.all([refreshSettings(), refreshTags(), refreshHealth()]);
  } catch (err) {
    toast(`Cannot reach the MailBlast server: ${err.message}`, 'error', 8000);
  }
  await navigate();
  setInterval(() => refreshHealth().catch(() => {}), 30_000);
})();
