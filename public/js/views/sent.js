import {
  el,
  mount,
  get,
  post,
  toast,
  debounce,
  formatDate,
  relativeTime,
  openModal,
  renderHtmlIntoFrame,
} from '../lib.js';
import { refreshHealth } from '../app.js';
import { historyParams, PAGE_SIZE, pageNumber, pageCount, visibleRange } from './query.js';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'sent', label: 'Sent' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'sending', label: 'In flight' },
];

export async function renderSent() {
  const state = {
    q: '',
    status: 'all',
    campaignId: '',
    from: '',
    to: '',
    order: 'newest',
    limit: PAGE_SIZE,
    offset: 0,
    total: 0,
    messages: [],
    campaigns: [],
  };

  const tableHost = el('div.table-wrap');
  const pagerHost = el('div.pager');
  const countHost = el('div.muted', { style: { fontSize: '12.5px' } });
  const statsHost = el('div.grid-stats');

  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search recipient, email, subject or body text…',
  });

  const statusSelect = el('select', {
    onchange: (event) => {
      state.status = event.target.value;
      state.offset = 0;
      load();
    },
  }, STATUS_OPTIONS.map((option) => el('option', { value: option.value, text: option.label })));

  const campaignSelect = el('select', {
    onchange: (event) => {
      state.campaignId = event.target.value;
      state.offset = 0;
      load();
    },
  });

  const fromInput = el('input', {
    type: 'date',
    onchange: (event) => {
      state.from = event.target.value;
      state.offset = 0;
      load();
    },
  });

  const toInput = el('input', {
    type: 'date',
    onchange: (event) => {
      state.to = event.target.value;
      state.offset = 0;
      load();
    },
  });

  const orderSelect = el('select', {
    onchange: (event) => {
      state.order = event.target.value;
      state.offset = 0;
      load();
    },
  }, [
    el('option', { value: 'newest', text: 'Newest first' }),
    el('option', { value: 'oldest', text: 'Oldest first' }),
  ]);

  const exportLink = el('a.btn.btn-sm', { download: 'sent-history.csv' }, 'Export CSV');

  /* ---------------------------------------------------------- clear history */

  function hasActiveFilters() {
    return Boolean(state.q || (state.status && state.status !== 'all') || state.campaignId || state.from || state.to);
  }

  async function clearHistory(scope) {
    try {
      const body =
        scope === 'filtered'
          ? {
              status: state.status,
              campaignId: state.campaignId || undefined,
              from: state.from ? `${state.from}T00:00:00.000Z` : undefined,
              to: state.to || undefined,
            }
          : { all: true, confirm: 'delete' };

      const result = await post('/api/messages/clear', body);
      toast(
        `Deleted ${result.deletedMessages} message${result.deletedMessages === 1 ? '' : 's'}` +
          (result.deletedCampaigns ? ` and ${result.deletedCampaigns} empty campaign${result.deletedCampaigns === 1 ? '' : 's'}` : '') +
          '.',
        'ok',
        6000,
      );
      state.offset = 0;
      await Promise.all([load(), loadStats(), refreshHealth()]);
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  function openClearDialog() {
    const filtered = hasActiveFilters();
    let scope = filtered ? 'filtered' : 'all';

    const scopeHost = el('div', { style: { display: 'grid', gap: '8px' } });
    const summaryHost = el('div');

    function renderSummary() {
      mount(
        summaryHost,
        scope === 'all'
          ? el('div.alert.alert-error', null, [
              el('strong', { text: `This deletes all ${state.total} recorded message${state.total === 1 ? '' : 's'}. ` }),
              'Sent history will be empty. Your contacts and settings are not touched. This cannot be undone.',
            ])
          : el('div.alert.alert-warn', null, [
              el('strong', { text: 'This deletes only the messages matching the current filters. ' }),
              'Clear the filters first if you meant to delete everything.',
            ]),
      );
    }

    const radio = (value, label, description) => {
      const input = el('input', {
        type: 'radio',
        name: 'clear-scope',
        checked: scope === value,
        onchange: () => {
          scope = value;
          renderSummary();
        },
      });
      return el('label', {
        style: {
          display: 'flex',
          gap: '9px',
          alignItems: 'flex-start',
          padding: '10px 12px',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          cursor: 'pointer',
        },
      }, [
        input,
        el('div', null, [
          el('div', { style: { fontWeight: '600', fontSize: '13px' }, text: label }),
          el('div.muted', { style: { fontSize: '11.5px' }, text: description }),
        ]),
      ]);
    };

    mount(
      scopeHost,
      filtered
        ? radio('filtered', 'Delete only the filtered messages', 'Keeps everything that does not match the current search and filters.')
        : null,
      radio('all', 'Delete the entire sent history', 'Removes every recorded message, sent or failed.'),
    );
    renderSummary();

    const dialog = openModal({
      title: 'Clear sent history',
      size: 'narrow',
      body: el('div', null, [scopeHost, el('div', { style: { marginTop: '12px' } }, [summaryHost])]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-danger', {
          type: 'button',
          onclick: async (event) => {
            event.target.disabled = true;
            event.target.textContent = 'Deleting…';
            dialog.close();
            await clearHistory(scope);
          },
        }, 'Delete history'),
      ],
    });
  }

  const purgeButton = el('button.btn.btn-sm.btn-danger', {
    type: 'button',
    title: 'Delete recorded messages',
    onclick: openClearDialog,
  }, 'Clear history');

  function queryParams(extra = {}) {
    return historyParams({
      q: state.q,
      status: state.status,
      campaignId: state.campaignId,
      from: state.from,
      to: state.to,
      order: state.order,
      limit: state.limit,
      offset: state.offset,
      ...extra,
    });
  }

  function renderStats(data) {
    mount(
      statsHost,
      [
        { label: 'Messages', value: data.totals.total, cls: '' },
        { label: 'Delivered', value: data.totals.sent, cls: 'green' },
        { label: 'Failed', value: data.totals.failed, cls: 'red' },
        { label: 'Contacts', value: data.contacts, cls: '' },
      ].map((item) =>
        el('div.stat', null, [
          el('div.label', { text: item.label }),
          el(`div.value${item.cls ? `.${item.cls}` : ''}`, { text: String(item.value ?? 0) }),
        ]),
      ),
    );

    mount(
      campaignSelect,
      el('option', { value: '', text: 'All campaigns' }),
      data.campaigns.map((campaign) =>
        el('option', {
          value: String(campaign.id),
          selected: String(campaign.id) === String(state.campaignId),
          text: `${campaign.name || campaign.subject || `Campaign ${campaign.id}`} (${campaign.sent}/${campaign.total})`,
        }),
      ),
    );
  }

  function statusBadge(status) {
    return el(`span.badge.badge-${status}`, { text: status });
  }

  function renderTable() {
    if (!state.messages.length) {
      const filtered = state.q || state.status !== 'all' || state.campaignId || state.from || state.to;
      mount(
        tableHost,
        el('div.empty', null, [
          el('span.big', { text: '↺' }),
          el('div', { text: filtered ? 'No sent messages match those filters.' : 'Nothing sent yet.' }),
          el('div', { style: { marginTop: '12px' } }, [
            filtered
              ? el('button.btn', {
                  type: 'button',
                  onclick: () => {
                    state.q = '';
                    state.status = 'all';
                    state.campaignId = '';
                    state.from = '';
                    state.to = '';
                    state.offset = 0;
                    searchInput.value = '';
                    statusSelect.value = 'all';
                    campaignSelect.value = '';
                    fromInput.value = '';
                    toInput.value = '';
                    load();
                  },
                }, 'Clear filters')
              : el('a.btn.btn-primary', { href: '#/compose' }, 'Write your first email'),
          ]),
        ]),
      );
      mount(pagerHost);
      return;
    }

    mount(
      tableHost,
      el('table', null, [
        el('thead', null, [
          el('tr', null, [
            el('th', { text: 'Status' }),
            el('th', { text: 'Recipient' }),
            el('th', { text: 'Subject' }),
            el('th', { text: 'Campaign' }),
            el('th', { text: 'Sent' }),
            el('th', { class: 'actions', text: '' }),
          ]),
        ]),
        el('tbody', null, state.messages.map((message) =>
          el('tr', { style: { cursor: 'pointer' }, onclick: () => openDetail(message.id) }, [
            el('td', null, [statusBadge(message.status)]),
            el('td', null, [
              el('div', null, [message.name ? el('strong', { text: message.name }) : el('span.muted', { text: '—' })]),
              el('div.mono.muted', { text: message.email }),
            ]),
            el('td', null, [
              el('div.truncate', { title: message.subject, text: message.subject || '(no subject)' }),
              message.error ? el('div.truncate', { style: { color: 'var(--red)', fontSize: '11.5px' }, text: message.error }) : null,
            ]),
            el('td.soft', null, [el('div.truncate', { style: { maxWidth: '180px' }, text: message.campaignName || '—' })]),
            el('td.nowrap', null, [
              el('div', { text: formatDate(message.sentAt ?? message.createdAt) }),
              el('div.muted', { style: { fontSize: '11px' }, text: relativeTime(message.sentAt ?? message.createdAt) }),
            ]),
            el('td.actions', null, [
              el('button.btn.btn-sm.btn-ghost', {
                type: 'button',
                title: 'View full message',
                onclick: (event) => {
                  event.stopPropagation();
                  openDetail(message.id);
                },
              }, 'View'),
            ]),
          ]),
        )),
      ]),
    );

    const pages = pageCount(state.total, state.limit);
    const page = pageNumber(state.offset, state.limit);
    const { first, last } = visibleRange(state.offset, state.limit, state.total);

    mount(
      pagerHost,
      el('div', { text: `Showing ${first}–${last} of ${state.total}` }),
      el('div', { style: { flex: '1' } }),
      el('button.btn.btn-sm', {
        type: 'button',
        disabled: state.offset === 0,
        onclick: () => {
          state.offset = Math.max(0, state.offset - state.limit);
          load();
        },
      }, '← Prev'),
      el('div', { text: `Page ${page} / ${pages}` }),
      el('button.btn.btn-sm', {
        type: 'button',
        disabled: state.offset + state.limit >= state.total,
        onclick: () => {
          state.offset += state.limit;
          load();
        },
      }, 'Next →'),
    );
  }

  async function load() {
    mount(tableHost, el('div.empty', null, [el('span.spinner')]));
    try {
      const data = await get(`/api/messages?${queryParams()}`);
      state.messages = data.messages;
      state.total = data.total;
      countHost.textContent = `${data.total} message${data.total === 1 ? '' : 's'}${
        state.q ? ` matching “${state.q}”` : ''
      }`;
      exportLink.href = `/api/messages/export?${queryParams({ limit: '5000', offset: '0' })}`;
      renderTable();
    } catch (err) {
      mount(tableHost, el('div.empty', { text: `Could not load history: ${err.message}` }));
    }
  }

  async function loadStats() {
    try {
      const data = await get('/api/stats');
      state.campaigns = data.campaigns ?? [];
      renderStats(data);
    } catch {
      /* stats are decorative; the table still works */
    }
  }

  function openDetail(id) {
    get(`/api/messages/${id}`)
      .then((message) => {
        const plain = el('pre.text-part', { text: message.text || '(no plain-text version)' });
        // Width must be set explicitly: an iframe defaults to ~300px, which is
        // why this preview used to occupy only a fraction of the modal.
        const frame = renderHtmlIntoFrame(
          el('iframe', { style: { width: '100%', height: '460px', border: '0', display: 'block' } }),
          message.html,
        );
        const htmlTab = el('button.tab.active', { type: 'button' }, 'HTML');
        const textTab = el('button.tab', { type: 'button' }, 'Plain text');
        const previewHost = el('div', { style: { width: '100%', minWidth: '0' } }, [frame]);

        const selectTab = (active, inactive, node) => {
          for (const tab of [htmlTab, textTab]) tab.classList.remove('active');
          active.classList.add('active');
          mount(previewHost, node);
        };
        htmlTab.addEventListener('click', () => selectTab(htmlTab, textTab, frame));
        textTab.addEventListener('click', () => selectTab(textTab, htmlTab, plain));

        const resendButton = el('button.btn.btn-primary', { type: 'button' }, 'Resend');
        resendButton.addEventListener('click', async () => {
          resendButton.disabled = true;
          resendButton.textContent = 'Sending…';
          try {
            const result = await post(`/api/messages/${id}/resend`, {});
            if (result.ok) {
              toast('Message resent.', 'ok');
              dialog.close();
              await Promise.all([load(), loadStats(), refreshHealth()]);
            } else {
              toast(result.error, 'error', 8000);
            }
          } catch (err) {
            toast(err.message, 'error', 8000);
          } finally {
            resendButton.disabled = false;
            resendButton.textContent = 'Resend';
          }
        });

        const dialog = openModal({
          title: message.subject || '(no subject)',
          size: 'wide',
          body: el('div', null, [
            el('dl.kv', { style: { marginBottom: '14px' } }, [
              el('dt', { text: 'To' }),
              el('dd', { text: message.name ? `${message.name} <${message.email}>` : message.email }),
              el('dt', { text: 'Status' }),
              el('dd', null, [statusBadge(message.status), message.error ? el('span', { style: { color: 'var(--red)' }, text: ` — ${message.error}` }) : null]),
              el('dt', { text: 'Sent' }),
              el('dd', { text: message.sentAt ? formatDate(message.sentAt) : formatDate(message.createdAt) }),
              el('dt', { text: 'Campaign' }),
              el('dd', { text: message.campaignName || '—' }),
              el('dt', { text: 'Transport' }),
              el('dd', { text: message.transport ?? '—' }),
              message.response ? el('dt', { text: 'Server reply' }) : null,
              message.response ? el('dd.mono', { text: message.response }) : null,
            ]),
            el('div.tabs', null, [htmlTab, textTab]),
            previewHost,
          ]),
          footer: [
            el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close'),
            resendButton,
          ],
        });
      })
      .catch((err) => toast(err.message, 'error'));
  }

  /* ----------------------------------------------------------------- assemble */

  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.q = searchInput.value.trim();
      state.offset = 0;
      load();
    }, 250),
  );

  const clearButton = el('button.btn.btn-sm', {
    type: 'button',
    onclick: () => {
      state.q = '';
      state.status = 'all';
      state.campaignId = '';
      state.from = '';
      state.to = '';
      state.offset = 0;
      searchInput.value = '';
      statusSelect.value = 'all';
      campaignSelect.value = '';
      fromInput.value = '';
      toInput.value = '';
      load();
    },
  }, 'Clear');

  const view = el('div', null, [
    el('div.page-head', null, [
      el('div', null, [
        el('h1', { text: 'Sent history' }),
        el('div.sub', { text: 'Every message is recorded individually — search by person, subject or body text.' }),
      ]),
      el('div.spacer'),
      el('div.actions', null, [exportLink, purgeButton]),
    ]),
    statsHost,
    el('div.card', { style: { marginTop: '16px' } }, [
      el('div.card-body', { style: { display: 'grid', gap: '12px' } }, [
        el('div.search-input', null, [searchInput]),
        el('div.row', null, [
          statusSelect,
          campaignSelect,
          el('div', { style: { flex: '0 0 auto', width: 'auto' } }, [orderSelect]),
        ]),
        el('div.row', null, [
          el('div', null, [
            el('label', { style: { fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase' }, text: 'From' }),
            fromInput,
          ]),
          el('div', null, [
            el('label', { style: { fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase' }, text: 'To' }),
            toInput,
          ]),
          el('div', { style: { flex: '0 0 auto', alignSelf: 'flex-end', width: 'auto' } }, [clearButton]),
        ]),
        countHost,
      ]),
    ]),
    el('div.card', { style: { marginTop: '16px' } }, [tableHost, pagerHost]),
  ]);

  view.addEventListener('route:enter', () => {
    load();
    loadStats();
  });

  await Promise.all([load(), loadStats()]);
  return view;
}
