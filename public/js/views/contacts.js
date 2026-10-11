import {
  el,
  mount,
  clear,
  get,
  post,
  put,
  del,
  toast,
  debounce,
  formatDate,
  openModal,
} from '../lib.js';
import { refreshHealth, refreshTags, invalidate, store } from '../app.js';
import { parseContacts } from '../csv.js';
import { contactParams, CONTACT_PAGE_SIZE, pageNumber, pageCount } from './query.js';

export async function renderContacts() {
  const state = {
    q: '',
    tag: '',
    sort: 'name',
    limit: CONTACT_PAGE_SIZE,
    offset: 0,
    total: 0,
    contacts: [],
    selected: new Set(),
  };

  const tableHost = el('div.table-wrap');
  const pagerHost = el('div.pager');
  const countHost = el('div.muted', { style: { fontSize: '12.5px' } });
  const tagHost = el('div.chip-list');
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search name, email, company or tag…',
  });

  const deleteSelectedButton = el('button.btn.btn-danger.btn-sm', {
    type: 'button',
    style: { display: 'none' },
    onclick: () => deleteSelected(),
  }, 'Delete selected');

  function renderTagFilter() {
    if (!store.tags.length) {
      mount(tagHost, el('span.muted', { style: { fontSize: '12px' }, text: 'No tags yet' }));
      return;
    }
    mount(
      tagHost,
      [
        el(`button.btn.btn-sm${state.tag === '' ? '.btn-primary' : ''}`, {
          type: 'button',
          text: 'All',
          onclick: () => {
            state.tag = '';
            state.offset = 0;
            renderTagFilter();
            load();
          },
        }),
        ...store.tags.map(({ tag, count }) =>
          el(`button.btn.btn-sm${state.tag === tag ? '.btn-primary' : ''}`, {
            type: 'button',
            text: `${tag} (${count})`,
            onclick: () => {
              state.tag = state.tag === tag ? '' : tag;
              state.offset = 0;
              renderTagFilter();
              load();
            },
          }),
        ),
      ],
    );
  }

  async function load() {
    mount(tableHost, el('div.empty', null, [el('span.spinner')]));
    try {
      const params = contactParams({
        q: state.q,
        tag: state.tag,
        sort: state.sort,
        limit: state.limit,
        offset: state.offset,
      });

      const data = await get(`/api/contacts?${params}`);
      state.contacts = data.contacts;
      state.total = data.total;
      renderTable();
    } catch (err) {
      mount(tableHost, el('div.empty', { text: `Could not load contacts: ${err.message}` }));
    }
  }

  function rowCheckbox(contact) {
    const box = el('input', {
      type: 'checkbox',
      checked: state.selected.has(contact.id),
      onchange: (event) => {
        if (event.target.checked) state.selected.add(contact.id);
        else state.selected.delete(contact.id);
        updateSelectionUi();
      },
    });
    return box;
  }

  function updateSelectionUi() {
    const n = state.selected.size;
    deleteSelectedButton.style.display = n ? '' : 'none';
    deleteSelectedButton.textContent = `Delete ${n} selected`;
  }

  function renderTable() {
    countHost.textContent = state.total
      ? `${state.total} contact${state.total === 1 ? '' : 's'}${state.q ? ` matching “${state.q}”` : ''}${
          state.tag ? ` tagged “${state.tag}”` : ''
        }`
      : '';

    if (!state.contacts.length) {
      mount(
        tableHost,
        el('div.empty', null, [
          el('span.big', { text: '☰' }),
          el('div', { text: state.q || state.tag ? 'No contacts match that filter.' : 'No contacts yet.' }),
          el('div', { style: { marginTop: '12px' } }, [
            el('button.btn.btn-primary', { type: 'button', onclick: openImportDialog }, 'Import contacts'),
          ]),
        ]),
      );
      mount(pagerHost);
      return;
    }

    const headCheck = el('input', {
      type: 'checkbox',
      checked: state.contacts.every((c) => state.selected.has(c.id)),
      onchange: (event) => {
        for (const contact of state.contacts) {
          if (event.target.checked) state.selected.add(contact.id);
          else state.selected.delete(contact.id);
        }
        renderTable();
        updateSelectionUi();
      },
    });

    const table = el('table', null, [
      el('thead', null, [
        el('tr', null, [
          el('th', { style: { width: '36px' } }, [headCheck]),
          el('th', { text: 'Name' }),
          el('th', { text: 'Email' }),
          el('th', { text: 'Company' }),
          el('th', { text: 'Tags' }),
          el('th', { text: 'Added' }),
          el('th', { class: 'actions', text: '' }),
        ]),
      ]),
      el('tbody', null, state.contacts.map((contact) =>
        el('tr', null, [
          el('td', null, [rowCheckbox(contact)]),
          el('td', null, [contact.name ? el('strong', { text: contact.name }) : el('span.muted', { text: '—' })]),
          el('td', null, [el('span.mono', { text: contact.email })]),
          el('td.soft', { text: contact.company || '—' }),
          el('td', null, [
            contact.tags.length
              ? el('div.chip-list', null, contact.tags.map((tag) => el('span.tag', { text: tag })))
              : el('span.muted', { text: '—' }),
          ]),
          el('td.muted.nowrap', { text: formatDate(contact.createdAt, { withTime: false }) }),
          el('td.actions', null, [
            el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => openEditDialog(contact) }, 'Edit'),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => confirmDelete(contact) }, '✕'),
          ]),
        ]),
      )),
    ]);

    mount(tableHost, table);

    const pages = pageCount(state.total, state.limit);
    const page = pageNumber(state.offset, state.limit);

    mount(
      pagerHost,
      el('div', { text: `Page ${page} of ${pages}` }),
      el('div.spacer', { style: { flex: '1' } }),
      el('button.btn.btn-sm', {
        type: 'button',
        disabled: state.offset === 0,
        onclick: () => {
          state.offset = Math.max(0, state.offset - state.limit);
          load();
        },
      }, '← Prev'),
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

  /* --------------------------------------------------------------- mutations */

  async function confirmDelete(contact) {
    const dialog = openModal({
      title: 'Delete contact',
      size: 'narrow',
      body: el('div', null, [
        el('p', { html: `Remove <strong>${contact.name || contact.email}</strong> from your contacts? Sent history is kept.` }),
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-danger', {
          type: 'button',
          onclick: async () => {
            try {
              await del(`/api/contacts/${contact.id}`);
              state.selected.delete(contact.id);
              toast('Contact deleted.', 'ok');
              dialog.close();
              await Promise.all([load(), refreshTags(), refreshHealth()]);
              renderTagFilter();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Delete'),
      ],
    });
  }

  async function deleteSelected() {
    const ids = [...state.selected];
    if (!ids.length) return;
    const dialog = openModal({
      title: 'Delete selected contacts',
      size: 'narrow',
      body: el('p', { text: `Delete ${ids.length} contact${ids.length === 1 ? '' : 's'}? This cannot be undone.` }),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-danger', {
          type: 'button',
          onclick: async () => {
            try {
              await post('/api/contacts/bulk-delete', { ids });
              state.selected.clear();
              toast(`${ids.length} contacts deleted.`, 'ok');
              dialog.close();
              await Promise.all([load(), refreshTags(), refreshHealth()]);
              renderTagFilter();
              updateSelectionUi();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Delete them'),
      ],
    });
  }

  async function openEditDialog(contact) {
    const nameInput = el('input', { type: 'text', value: contact.name });
    const emailInput = el('input', { type: 'email', value: contact.email });
    const companyInput = el('input', { type: 'text', value: contact.company });
    const tagsInput = el('input', { type: 'text', value: contact.tags.join(', '), placeholder: 'vip, newsletter' });

    const dialog = openModal({
      title: 'Edit contact',
      size: 'narrow',
      body: el('div', null, [
        el('div.field', null, [el('label', { text: 'Name' }), nameInput]),
        el('div.field', null, [el('label', { text: 'Email' }), emailInput]),
        el('div.field', null, [el('label', { text: 'Company' }), companyInput]),
        el('div.field', null, [el('label', { text: 'Tags' }), tagsInput]),
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            try {
              await put(`/api/contacts/${contact.id}`, {
                name: nameInput.value,
                email: emailInput.value,
                company: companyInput.value,
                tags: tagsInput.value,
              });
              toast('Contact saved.', 'ok');
              dialog.close();
              await Promise.all([load(), refreshTags()]);
              renderTagFilter();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Save'),
      ],
    });
  }

  function openAddDialog() {
    const nameInput = el('input', { type: 'text', placeholder: 'Ada Lovelace' });
    const emailInput = el('input', { type: 'email', placeholder: 'ada@example.com' });
    const companyInput = el('input', { type: 'text', placeholder: 'Analytical Engines' });
    const tagsInput = el('input', { type: 'text', placeholder: 'vip, newsletter' });

    const dialog = openModal({
      title: 'Add a contact',
      size: 'narrow',
      body: el('div', null, [
        el('div.field', null, [el('label', { text: 'Name' }), nameInput]),
        el('div.field', null, [el('label', { text: 'Email' }), emailInput]),
        el('div.field', null, [el('label', { text: 'Company' }), companyInput]),
        el('div.field', null, [el('label', { text: 'Tags' }), tagsInput]),
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            try {
              await post('/api/contacts', {
                name: nameInput.value,
                email: emailInput.value,
                company: companyInput.value,
                tags: tagsInput.value,
              });
              toast('Contact added.', 'ok');
              dialog.close();
              await Promise.all([load(), refreshTags(), refreshHealth()]);
              renderTagFilter();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Add contact'),
      ],
    });
  }

  /* ---------------------------------------------------------- import dialog */

  function openImportDialog() {
    const parsed = { contacts: [], skipped: [], columns: [], hadHeader: false };
    let rawText = '';
    let defaultTags = [];
    let mode = 'merge';

    const dropzone = el('div.dropzone', null, [
      el('span.big', { text: '⬆' }),
      el('strong', { text: 'Drop a CSV file here, or click to choose' }),
      el('div.soft', { text: 'Columns are matched automatically — Name, Email, Company, Tags (any order)' }),
    ]);
    const fileInput = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', style: { display: 'none' } });

    const pasteArea = el('textarea.code', {
      rows: 6,
      placeholder: 'name,email,company,tags\nAda Lovelace,ada@example.com,Analytical Engines,vip\nGrace Hopper,grace@example.com,Navy,',
    });

    const tagInput = el('input', { type: 'text', placeholder: 'newsletter, 2026' });
    const tagChips = el('div.chip-list', { style: { marginTop: '8px' } });

    const previewHost = el('div');
    const summaryHost = el('div');

    const importButton = el('button.btn.btn-primary', { type: 'button', disabled: true }, 'Import');
    const modeSelect = el('select', {
      onchange: (event) => {
        mode = event.target.value;
      },
    }, [
      el('option', { value: 'merge', text: 'Update existing contacts, add new ones (recommended)' }),
      el('option', { value: 'skip', text: 'Skip contacts that already exist' }),
      el('option', { value: 'replace', text: 'Replace existing details (name, company, tags)' }),
    ]);

    function refreshTagChips() {
      mount(
        tagChips,
        defaultTags.map((tag) =>
          el('span.chip', null, [
            tag,
            el('button', {
              type: 'button',
              text: '✕',
              onclick: () => {
                defaultTags = defaultTags.filter((t) => t !== tag);
                refreshTagChips();
              },
            }),
          ]),
        ),
      );
    }

    function ingest(text, sourceLabel) {
      rawText = text;
      const result = parseContacts(text);
      parsed.contacts = result.contacts;
      parsed.skipped = result.skipped;
      parsed.columns = result.columns;
      parsed.hadHeader = result.hadHeader;
      renderPreview(sourceLabel);
    }

    function renderPreview(sourceLabel) {
      const unique = new Map();
      for (const contact of parsed.contacts) {
        const key = contact.email.toLowerCase();
        if (!unique.has(key)) unique.set(key, contact);
      }
      const duplicates = parsed.contacts.length - unique.size;
      const missingNames = [...unique.values()].filter((c) => !c.name).length;

      importButton.disabled = unique.size === 0;

      mount(
        summaryHost,
        el('div.alert.alert-ok', null, [
          el('strong', { text: `${parsed.contacts.length} row${parsed.contacts.length === 1 ? '' : 's'} read` }),
          ` from ${sourceLabel} · ${unique.size} unique email${unique.size === 1 ? '' : 's'}`,
          duplicates ? ` · ${duplicates} duplicate row${duplicates === 1 ? '' : 's'} in the file` : '',
          missingNames ? ` · ${missingNames} without a name` : '',
          parsed.skipped.length ? ` · ${parsed.skipped.length} skipped` : '',
        ]),
        parsed.skipped.length
          ? el('div.alert.alert-warn', null, [
              el('strong', { text: 'Skipped rows: ' }),
              parsed.skipped
                .slice(0, 6)
                .map((row) => `line ${row.line} (${row.reason})`)
                .join(', '),
              parsed.skipped.length > 6 ? `, +${parsed.skipped.length - 6} more` : '',
            ])
          : null,
      );

      const preview = [...unique.values()].slice(0, 12);
      mount(
        previewHost,
        preview.length
          ? el('div.table-wrap', { style: { maxHeight: '240px', overflowY: 'auto' } }, [
              el('table', null, [
                el('thead', null, [
                  el('tr', null, [
                    el('th', { text: 'Name' }),
                    el('th', { text: 'Email' }),
                    el('th', { text: 'Company' }),
                    el('th', { text: 'Tags' }),
                  ]),
                ]),
                el('tbody', null, preview.map((contact) =>
                  el('tr', null, [
                    el('td', { text: contact.name || '—' }),
                    el('td.mono', { text: contact.email }),
                    el('td.soft', { text: contact.company || '—' }),
                    el('td', null, [
                      [...new Set([...contact.tags, ...defaultTags])].map((tag) => el('span.tag', { text: tag })),
                    ]),
                  ]),
                )),
              ]),
            ])
          : el('div.muted', { style: { padding: '10px 0' }, text: 'Nothing recognised yet — paste a CSV or choose a file.' }),
      );
    }

    const readFile = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        pasteArea.value = String(reader.result ?? '');
        ingest(pasteArea.value, file.name);
      };
      reader.onerror = () => toast('Could not read that file.', 'error');
      reader.readAsText(file);
    };

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => readFile(fileInput.files?.[0]));
    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
      const file = event.dataTransfer?.files?.[0];
      if (file) readFile(file);
      else if (event.dataTransfer?.getData('text')) ingest(event.dataTransfer.getData('text'), 'dropped text');
    });

    pasteArea.addEventListener('input', () => ingest(pasteArea.value, 'pasted text'));
    pasteArea.addEventListener('paste', (event) => {
      const html = event.clipboardData?.getData('text/html');
      if (!html) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const table = doc.querySelector('table');
      if (!table) return;
      event.preventDefault();
      const rows = [...table.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((cell) => cell.textContent.trim()),
      );
      const text = rows.map((row) => row.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(',')).join('\n');
      pasteArea.value = text;
      ingest(text, 'spreadsheet paste');
      toast('Spreadsheet data detected — converted to rows.', 'ok');
    });

    tagInput.addEventListener('change', () => {
      defaultTags = tagInput.value.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
      tagInput.value = defaultTags.join(', ');
      refreshTagChips();
      if (parsed.contacts.length) renderPreview('your data');
    });

    importButton.addEventListener('click', async () => {
      importButton.disabled = true;
      importButton.textContent = 'Importing…';
      try {
        const result = await post('/api/contacts/import', { csv: rawText, mode, tags: defaultTags });
        toast(
          `Import finished: ${result.created} added, ${result.updated} updated${
            result.skippedExisting ? `, ${result.skippedExisting} skipped` : ''
          }.`,
          'ok',
          7000,
        );
        dialog.close();
        invalidate('compose');
        state.offset = 0;
        await Promise.all([load(), refreshTags(), refreshHealth()]);
        renderTagFilter();
      } catch (err) {
        toast(err.message, 'error', 7000);
        importButton.disabled = false;
        importButton.textContent = 'Import';
      }
    });

    const dialog = openModal({
      title: 'Import contacts',
      size: 'wide',
      body: el('div', null, [
        el('div.grid.grid-2', null, [
          el('div', null, [dropzone, fileInput]),
          el('div', null, [
            el('div.field', null, [
              el('label', { text: '…or paste your data' }),
              pasteArea,
              el('div.help', { text: 'Copy straight from Excel or Google Sheets — tabs and quoted commas both work.' }),
            ]),
          ]),
        ]),
        el('div', { style: { marginTop: '16px' } }, [
          el('div.field', null, [
            el('label', { text: 'Add these tags to everyone in this import (optional)' }),
            tagInput,
            tagChips,
          ]),
          el('div.field', null, [
            el('label', { text: 'If a contact already exists' }),
            modeSelect,
          ]),
        ]),
        summaryHost,
        previewHost,
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        importButton,
      ],
    });

    refreshTagChips();
    renderPreview('your data');
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

  const sortSelect = el('select', {
    style: { width: 'auto' },
    onchange: (event) => {
      state.sort = event.target.value;
      load();
    },
  }, [
    el('option', { value: 'name', text: 'Sort: Name' }),
    el('option', { value: 'created', text: 'Sort: Recently added' }),
  ]);

  const view = el('div', null, [
    el('div.page-head', null, [
      el('div', null, [
        el('h1', { text: 'Contacts' }),
        el('div.sub', { text: 'Import Name + Email pairs from CSV, then use them as personalized recipients.' }),
      ]),
      el('div.spacer'),
      el('div.actions', null, [
        el('a.btn.btn-sm', { href: '/api/contacts/export', download: 'contacts.csv' }, 'Export CSV'),
        el('button.btn.btn-sm', { type: 'button', onclick: openAddDialog }, '+ Add contact'),
        el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: openImportDialog }, '⬆ Import contacts'),
      ]),
    ]),
    el('div.card', null, [
      el('div.card-body', { style: { display: 'grid', gap: '12px' } }, [
        el('div.row', null, [
          el('div.search-input', null, [searchInput]),
          el('div', { style: { flex: '0 0 auto', width: 'auto' } }, [sortSelect]),
        ]),
        el('div', null, [
          el('div.muted', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '6px' }, text: 'Filter by tag' }),
          tagHost,
        ]),
        el('div.row', null, [countHost, el('div', { style: { flex: '0 0 auto' } }, [deleteSelectedButton])]),
      ]),
    ]),
    el('div.card', { style: { marginTop: '16px' } }, [tableHost, pagerHost]),
  ]);

  renderTagFilter();
  await load();
  updateSelectionUi();

  return view;
}
