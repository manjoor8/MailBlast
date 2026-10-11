/* Saved compose messages: reopen them in the composer, copy them, or delete them. */

import {
  el,
  mount,
  get,
  post,
  del,
  toast,
  debounce,
  formatDate,
  relativeTime,
  pluralize,
  openModal,
} from '../lib.js';

/** Human wording for how a draft picks its recipients. */
function recipientLabel(draft) {
  if (draft.recipientMode === 'tags') {
    const tags = (draft.tags ?? []).filter(Boolean);
    return tags.length ? `By tag: ${tags.join(', ')}` : 'By tag';
  }
  if (draft.recipientMode === 'manual') return 'Manual list';
  return 'All contacts';
}

/** Plain-text snippet of the message body, since the list shows markup-free previews. */
function bodySnippet(html) {
  const text = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 160 ? `${text.slice(0, 160).trimEnd()}…` : text;
}

function subtitle(parts) {
  return el('div.soft', { style: { fontSize: '12px', marginTop: '2px', overflowWrap: 'anywhere' } }, [
    el('span', { text: parts.join(' · ') }),
  ]);
}

export async function renderDrafts() {
  const state = {
    q: '',
    limit: 50,
    total: 0,
    drafts: [],
  };

  const tableHost = el('div.table-wrap');
  const countHost = el('div.muted', { style: { fontSize: '12.5px' } });
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search draft name, subject or body…',
  });

  /* -------------------------------------------------------------- list render */

  function renderList() {
    countHost.textContent = state.total
      ? `${pluralize(state.total, 'draft')}${state.q ? ` matching “${state.q}”` : ''}`
      : '';

    if (!state.drafts.length) {
      mount(tableHost, emptyState());
      return;
    }

    const table = el('table', null, [
      el('thead', null, [
        el('tr', null, [
          el('th', { text: 'Draft' }),
          el('th', { text: 'Recipients' }),
          el('th', { text: 'Last updated' }),
          el('th.actions', { text: '' }),
        ]),
      ]),
      el('tbody', null, state.drafts.map(draftRow)),
    ]);

    mount(tableHost, table);
  }

  function emptyState() {
    if (state.q) {
      return el('div.empty', null, [
        el('span.big', { text: '⌕' }),
        el('div', { text: `No drafts match “${state.q}”.` }),
      ]);
    }
    return el('div.empty', null, [
      el('span.big', { text: '✎' }),
      el('div', { text: 'No saved drafts yet.' }),
      el('div.soft', {
        style: { marginTop: '4px', fontSize: '12.5px' },
        text: 'Write a message in the composer and save it to keep it here.',
      }),
      el('div', { style: { marginTop: '14px' } }, [
        el('a.btn.btn-primary', { href: '#/compose' }, 'New draft'),
      ]),
    ]);
  }

  function draftRow(draft) {
    const subject = String(draft.subject ?? '').trim();
    const snippet = bodySnippet(draft.html);
    const files = (draft.attachmentIds ?? []).length;
    const filesPill = el('span.pill', { text: `${files} file${files === 1 ? '' : 's'}` });

    const meta = [
      subject ? `Subject: ${subject}` : 'No subject yet',
      snippet ? `Preview: ${snippet}` : 'No body yet',
    ];
    if (files) meta.push(`${files} attachment${files === 1 ? '' : 's'}`);

    return el('tr', null, [
      el('td', null, [
        el('strong', { text: draft.name || 'Untitled draft' }),
        subtitle(meta),
      ]),
      el('td.soft', null, [
        el('div', { text: recipientLabel(draft) }),
        files ? el('div', { style: { marginTop: '4px' } }, [filesPill]) : null,
      ]),
      el('td.nowrap', null, [
        el('div', { text: `Updated ${relativeTime(draft.updatedAt)}` }),
        el('div.muted', { style: { fontSize: '11.5px' }, text: formatDate(draft.updatedAt) }),
      ]),
      el('td.actions', null, [
        el('a.btn.btn-sm.btn-primary', { href: `#/compose?draft=${draft.id}` }, 'Open'),
        el('button.btn.btn-sm.btn-ghost', {
          type: 'button',
          onclick: () => duplicateDraft(draft),
        }, 'Duplicate'),
        el('button.btn.btn-sm.btn-ghost', {
          type: 'button',
          onclick: () => confirmDelete(draft),
        }, 'Delete'),
      ]),
    ]);
  }

  async function load() {
    mount(tableHost, el('div.empty', null, [el('span.spinner'), el('div', { text: 'Loading drafts…' })]));

    try {
      const params = new URLSearchParams({ limit: String(state.limit) });
      if (state.q) params.set('q', state.q);

      const data = await get(`/api/drafts?${params}`);
      state.drafts = data.drafts ?? [];
      state.total = data.total ?? state.drafts.length;
      renderList();
    } catch (err) {
      mount(tableHost, el('div.empty', { text: `Could not load drafts: ${err.message}` }));
    }
  }

  /* --------------------------------------------------------------- mutations */

  async function duplicateDraft(draft) {
    try {
      await post(`/api/drafts/${draft.id}/duplicate`, {});
      toast('Draft duplicated.', 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function confirmDelete(draft) {
    const dialog = openModal({
      title: 'Delete draft',
      size: 'narrow',
      body: el('div', null, [
        el('p', null, [
          'Delete ',
          el('strong', { text: draft.name || 'this draft' }),
          '? This cannot be undone.',
        ]),
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-danger', {
          type: 'button',
          onclick: async () => {
            try {
              await del(`/api/drafts/${draft.id}`);
              toast('Draft deleted.', 'ok');
              dialog.close();
              await load();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Delete'),
      ],
    });
  }

  /* ---------------------------------------------------------------- assemble */

  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.q = searchInput.value.trim();
      load();
    }, 250),
  );

  const view = el('div', null, [
    el('div.page-head', null, [
      el('div', null, [
        el('h1', { text: 'Drafts' }),
        el('div.sub', {
          text: 'Saved compose messages. Open one in the composer to keep writing, or copy it to start a new message.',
        }),
      ]),
      el('div.spacer'),
      el('div.actions', null, [
        el('a.btn.btn-primary.btn-sm', { href: '#/compose' }, '✎ New draft'),
      ]),
    ]),
    el('div.card', null, [
      el('div.card-body', { style: { display: 'grid', gap: '12px' } }, [
        el('div.search-input', null, [searchInput]),
        countHost,
      ]),
    ]),
    el('div.card', { style: { marginTop: '16px' } }, [tableHost]),
  ]);

  await load();

  return view;
}
