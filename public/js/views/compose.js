import {
  el,
  mount,
  clear,
  get,
  post,
  put,
  toast,
  debounce,
  formatDate,
  openModal,
  renderHtmlIntoFrame,
} from '../lib.js';
import { store, refreshHealth, refreshSettings } from '../app.js';
import { createEditor } from '../editor.js';

/* ---------------------------------------------------------------- templates */

const STARTERS = {
  'Blank HTML': `<!doctype html>
<html>
  <body style="margin:0;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b1f24;background:#f5f6f8;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <h1 style="margin:0 0 12px;font-size:22px;">Hi {{first_name}},</h1>
        <p style="margin:0 0 16px;line-height:1.6;color:#3a4149;">
          Write your message here.
        </p>
        <p style="margin:24px 0 0;">
          <a href="https://example.com" style="display:inline-block;background:#2f6df6;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;">Read more</a>
        </p>
        <p style="margin:28px 0 0;font-size:13px;color:#8b95a3;">
          Cheers,<br />The Team
        </p>
      </td></tr>
    </table>
  </body>
</html>`,

  Newsletter: `<div style="max-width:640px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;color:#22262b;">
  <div style="background:#111827;color:#ffffff;padding:28px 32px;border-radius:12px 12px 0 0;">
    <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.7;">Monthly digest</div>
    <h1 style="margin:8px 0 0;font-size:26px;">Hello {{first_name}}, here's what's new</h1>
  </div>
  <div style="border:1px solid #e3e6ea;border-top:0;border-radius:0 0 12px 12px;padding:28px 32px;">
    <h2 style="margin:0 0 8px;font-size:17px;">① A headline worth reading</h2>
    <p style="margin:0 0 20px;line-height:1.7;color:#4a525c;">
      Two or three sentences of summary that make the reader want the full story.
    </p>
    <h2 style="margin:0 0 8px;font-size:17px;">② Another highlight</h2>
    <p style="margin:0 0 24px;line-height:1.7;color:#4a525c;">
      Keep paragraphs short. Most people skim on a phone.
    </p>
    <hr style="border:0;border-top:1px solid #e3e6ea;margin:24px 0;" />
    <p style="margin:0;font-size:13px;color:#8b95a3;">
      You are receiving this because you subscribed. Reply to unsubscribe.
    </p>
  </div>
</div>`,

  'Plain-style note': `<p>Hi {{first_name}},</p>

<p>Quick note — no images, no buttons, just a message that lands in the inbox like a normal email.</p>

<p>If you have any questions, just reply to this message.</p>

<p>Thanks,<br />The Team</p>`,
};

const DRAFT_KEY = 'mailblast.draft.v1';

/* ------------------------------------------------------------------- helpers */

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage may be unavailable; drafts are a convenience only */
  }
}

function statusBadge(status) {
  return el(`span.badge.badge-${status}`, { text: status });
}

/* ---------------------------------------------------------------------- view */

export async function renderCompose() {
  const autosaved = loadDraft() ?? {};

  // Which draft to open: either saved explicitly, or an autosave of unsaved work.
  const hashQuery = window.location.hash.includes('?')
    ? new URLSearchParams(window.location.hash.split('?')[1])
    : new URLSearchParams();
  const requestedDraftId = Number(hashQuery.get('draft')) || null;

  const state = {
    subject: autosaved.subject ?? '',
    html: autosaved.html ?? STARTERS['Blank HTML'],
    fromName: autosaved.fromName ?? '',
    campaignName: autosaved.campaignName ?? '',
    personalize: autosaved.personalize ?? true,
    delayMs: autosaved.delayMs ?? 250,
    /** Ticked contact ids; `null` until the picker first initialises. */
    selectedIds: null,
    search: '',
    /** Kept only to seed the selection when resuming an older draft. */
    legacyRecipientMode: autosaved.recipientMode ?? 'none',
    selectedTags: autosaved.selectedTags ?? [],
    manual: autosaved.manual ?? '',
    contacts: [],
    totalContacts: 0,
    recipients: [],
    preview: { subject: '', html: '', text: '', sample: null },
    sending: false,
    currentJob: null,
    /** Saved-draft identity. Null means "not saved to the server yet". */
    draftId: null,
    draftName: '',
    draftSavedAt: null,
    dirty: false,
    /** Attachments: [{ id, filename, size, contentType }] */
    attachments: [],
  };

  /* ------------------------------------------------------------ data loading */

  const loadContacts = async () => {
    const data = await get('/api/contacts?limit=1000');
    state.contacts = data.contacts;
    state.totalContacts = data.total;
  };

  try {
    await loadContacts();
  } catch (err) {
    return el('div.alert.alert-error', { text: `Could not load contacts: ${err.message}` });
  }

  /**
   * Contacts currently visible in the picker: everything, narrowed by the
   * search box and any tag filters. Search matches name and email.
   */
  const visibleContacts = () => {
    const q = state.search.trim().toLowerCase();
    return state.contacts.filter((contact) => {
      if (state.selectedTags.length && !contact.tags.some((t) => state.selectedTags.includes(t))) {
        return false;
      }
      if (!q) return true;
      return (
        String(contact.name ?? '').toLowerCase().includes(q) ||
        String(contact.email ?? '').toLowerCase().includes(q) ||
        String(contact.company ?? '').toLowerCase().includes(q)
      );
    });
  };

  /** Addresses typed into the manual box, which have no contact record. */
  const manualRecipients = () =>
    state.manual
      .split(/[\s,;]+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((email) => ({ name: '', email, tags: [] }));

  /**
   * Who the message will actually go to: the ticked contacts, plus any manually
   * typed addresses. A contact is only ever included when its box is checked,
   * so nothing is sent by accident.
   */
  const selectedRecipients = () => [
    ...state.contacts.filter((c) => state.selectedIds.has(c.id)),
    ...manualRecipients(),
  ];

  /** One-time upgrade of an old draft that stored a mode instead of ticked ids. */
  function ensureSelection() {
    if (state.selectedIds instanceof Set) return;
    const previousMode = state.legacyRecipientMode;
    let ids = [];
    if (previousMode === 'all') ids = state.contacts.map((c) => c.id);
    else if (previousMode === 'tags' && state.selectedTags.length) {
      ids = state.contacts
        .filter((c) => c.tags.some((t) => state.selectedTags.includes(t)))
        .map((c) => c.id);
    }
    state.selectedIds = new Set(ids);
  }

  /* ------------------------------------------------------------------ elements */

  const subjectInput = el('input', {
    type: 'text',
    placeholder: 'e.g. A quick update for {{first_name}}',
    value: state.subject,
    oninput: (event) => {
      state.subject = event.target.value;
      scheduleDraft();
      schedulePreview();
    },
  });

  const fromInput = el('input', {
    type: 'text',
    placeholder: store.settings?.smtp?.fromName || 'Your name',
    value: state.fromName,
    oninput: (event) => {
      state.fromName = event.target.value;
      scheduleDraft();
    },
  });

  const campaignInput = el('input', {
    type: 'text',
    placeholder: 'e.g. October product update',
    value: state.campaignName,
    oninput: (event) => {
      state.campaignName = event.target.value;
      scheduleDraft();
    },
  });

  // A real WYSIWYG surface; the raw HTML view lives behind the editor's own
  // "HTML source" tab rather than being the primary way to write a message.
  const editor = createEditor({
    value: state.html,
    onChange: (html) => {
      state.html = html;
      scheduleDraft();
    },
    onPreview: () => schedulePreview(),
  });

  const templateSelect = el('select', {
    onchange: (event) => {
      const choice = event.target.value;
      if (STARTERS[choice]) {
        state.html = STARTERS[choice];
        editor.setHtml(state.html);
        scheduleDraft();
        schedulePreview();
        toast(`Loaded the “${choice}” template.`, 'ok');
      }
      event.target.value = '';
    },
  }, [
    el('option', { value: '', text: 'Insert template…' }),
    ...Object.keys(STARTERS).map((key) => el('option', { value: key, text: key })),
  ]);

  const plainPreview = el('pre.text-part', { style: { display: 'none' } });

  const previewSubject = el('div.field', null, [
    el('label', { text: 'Rendered subject' }),
    el('div.soft', { id: 'pv-subject', text: '—' }),
  ]);

  const previewFrame = el('iframe.preview-frame', { title: 'Email preview' });
  const previewWho = el('div.help');

  const recipientsSummary = el('div');
  const recipientsList = el('div.recipient-list');

  const personalizeCheck = el('input', {
    type: 'checkbox',
    checked: state.personalize,
    onchange: (event) => {
      state.personalize = event.target.checked;
      scheduleDraft();
      schedulePreview();
      renderRecipients();
    },
  });

  const delayInput = el('input', {
    type: 'number',
    min: '0',
    max: '60000',
    step: '50',
    value: String(state.delayMs),
    onchange: (event) => {
      state.delayMs = Math.max(0, Number(event.target.value) || 0);
      scheduleDraft();
    },
  });

  const sendButton = el('button.btn.btn-primary', {
    type: 'button',
    onclick: () => handleSend(),
  }, 'Send now');

  const testButton = el('button.btn', {
    type: 'button',
    onclick: () => openTestDialog(),
  }, 'Send test');

  const progressPanel = el('div.card', { style: { display: 'none' } });

  /* --------------------------------------------------------------- insertions */

  function insertToken(text) {
    editor.insertToken(text);
    state.html = editor.getHtml();
    scheduleDraft();
    schedulePreview();
  }

  /* ------------------------------------------------------------------ preview */

  const runPreview = async () => {
    try {
      const sample = selectedRecipients()[0] ?? {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        company: 'Analytical Engines',
      };
      const result = await post('/api/preview', {
        subject: state.subject,
        html: state.html,
        personalize: state.personalize,
        contact: sample,
      });
      state.preview = result;
      previewSubject.querySelector('#pv-subject').textContent = result.subject || '(no subject)';
      previewWho.textContent = `Previewed with ${result.sample.name} <${result.sample.email}>${
        state.personalize ? '' : ' — personalization is off'
      }`;
      plainPreview.textContent = result.text || '(empty)';
      renderHtmlIntoFrame(previewFrame, result.html);
    } catch (err) {
      previewWho.textContent = `Preview failed: ${err.message}`;
    }
  };

  const schedulePreview = debounce(runPreview, 400);
  const scheduleDraft = debounce(() => {
    // Local autosave: a safety net for an accidental refresh or navigation,
    // separate from explicitly saved drafts.
    saveDraft({
      subject: state.subject,
      html: state.html,
      fromName: state.fromName,
      campaignName: state.campaignName,
      personalize: state.personalize,
      delayMs: state.delayMs,
      selectedTags: state.selectedTags,
      manual: state.manual,
      selectedIds: state.selectedIds instanceof Set ? [...state.selectedIds] : [],
    });
    markDirty();
  }, 500);

  /* --------------------------------------------------------------- recipients */

  function renderRecipients() {
    ensureSelection();

    const visible = visibleContacts();
    const chosen = state.contacts.filter((c) => state.selectedIds.has(c.id));
    const manual = manualRecipients();
    const total = chosen.length + manual.length;

    state.recipients = [...chosen, ...manual];

    /* ----- summary ----- */
    const stat = (value, label) =>
      el('div', null, [
        el('div', { style: { fontSize: '22px', fontWeight: '680' }, text: String(value) }),
        el('div.muted', { style: { fontSize: '11.5px' }, text: label }),
      ]);

    clear(recipientsSummary).append(
      el('div.row', null, [
        stat(total, total === 1 ? 'recipient selected' : 'recipients selected'),
        stat(new Set(state.recipients.map((c) => c.email.toLowerCase())).size, 'unique addresses'),
        stat(state.contacts.length, 'contacts on file'),
      ]),
    );

    /* ----- select-all state for the visible subset ----- */
    const allVisibleChosen = visible.length > 0 && visible.every((c) => state.selectedIds.has(c.id));
    const someVisibleChosen = visible.some((c) => state.selectedIds.has(c.id));
    selectAllCheck.checked = allVisibleChosen;
    selectAllCheck.indeterminate = !allVisibleChosen && someVisibleChosen;
    selectAllCheck.disabled = visible.length === 0;

    const visibleChosenCount = visible.filter((c) => state.selectedIds.has(c.id)).length;
    selectAllLabel.textContent = visible.length
      ? `Select all ${visible.length} shown${visibleChosenCount ? ` (${visibleChosenCount} selected)` : ''}`
      : 'Nothing to select';

    clearCountButton.disabled = state.selectedIds.size === 0;

    /* ----- the list ----- */
    if (!state.contacts.length) {
      mount(
        recipientsList,
        el('div.empty', { style: { padding: '24px 16px' } }, [
          el('span.big', { text: '☰' }),
          el('div', { text: 'No contacts yet — import some on the Contacts page.' }),
          el('div', { style: { marginTop: '10px' } }, [
            el('a.btn.btn-sm', { href: '#/contacts' }, 'Go to Contacts'),
          ]),
        ]),
      );
      return;
    }

    if (!visible.length) {
      mount(
        recipientsList,
        el('div.empty', { style: { padding: '24px 16px' } }, [
          el('span.big', { text: '⌕' }),
          el('div', {
            text: state.search
              ? `No contact matches “${state.search}”${state.selectedTags.length ? ' with those tags' : ''}.`
              : 'No contact has those tags.',
          }),
        ]),
      );
      return;
    }

    mount(
      recipientsList,
      visible.map((contact) => {
        const box = el('input', {
          type: 'checkbox',
          checked: state.selectedIds.has(contact.id),
          onchange: (event) => {
            if (event.target.checked) state.selectedIds.add(contact.id);
            else state.selectedIds.delete(contact.id);
            scheduleDraft();
            renderRecipients();
            refreshSendButton();
            schedulePreview();
          },
        });

        return el('label.item', { style: { cursor: 'pointer' } }, [
          box,
          el('span.who', null, [
            contact.name
              ? el('span.name', { text: contact.name })
              : el('span.name.muted', { text: '(no name)' }),
            el('span', { text: ' · ' }),
            el('span.email', { text: contact.email }),
            contact.tags.length
              ? el('span', { style: { marginLeft: '6px' } }, contact.tags.map((tag) => el('span.tag', { text: tag })))
              : null,
          ]),
          state.personalize && !contact.name
            ? el('span.badge.badge-skipped', {
                title: 'No name on file — {{name}} falls back to the part before @',
                text: 'no name',
              })
            : null,
        ]);
      }),
    );
  }

  /* ------------------------------------------------------------- recipient UI */

  const recipientSearch = el('input', {
    type: 'search',
    placeholder: 'Search contacts by name or email…',
    value: state.search,
    oninput: (event) => {
      state.search = event.target.value;
      renderRecipients();
    },
  });

  const selectAllCheck = el('input', {
    type: 'checkbox',
    onchange: (event) => {
      ensureSelection();
      const visible = visibleContacts();
      for (const contact of visible) {
        if (event.target.checked) state.selectedIds.add(contact.id);
        else state.selectedIds.delete(contact.id);
      }
      scheduleDraft();
      renderRecipients();
      refreshSendButton();
      schedulePreview();
    },
  });

  const selectAllLabel = el('span', { text: 'Select all shown' });

  const clearCountButton = el('button.btn.btn-sm', {
    type: 'button',
    text: 'Clear selection',
    onclick: () => {
      state.selectedIds = new Set();
      state.manual = '';
      manualBox.value = '';
      scheduleDraft();
      renderRecipients();
      refreshSendButton();
      schedulePreview();
    },
  });

  const manualBox = el('textarea', {
    rows: 2,
    placeholder: 'Or type extra addresses: ada@example.com, grace@example.com',
    value: state.manual,
    oninput: (event) => {
      state.manual = event.target.value;
      scheduleDraft();
      renderRecipients();
      refreshSendButton();
      schedulePreview();
    },
  });

  const tagBox = el('div.chip-list');

  function renderTagPicker() {
    if (!store.tags.length) {
      mount(tagBox, el('span.muted', { style: { fontSize: '12px' }, text: 'No tags yet — add tags while importing contacts.' }));
      return;
    }
    mount(
      tagBox,
      store.tags.map(({ tag, count }) => {
        const active = state.selectedTags.includes(tag);
        return el(`button.btn.btn-sm${active ? '.btn-primary' : ''}`, {
          type: 'button',
          text: `${tag} (${count})`,
          title: 'Filter the list by this tag',
          onclick: () => {
            state.selectedTags = active
              ? state.selectedTags.filter((t) => t !== tag)
              : [...state.selectedTags, tag];
            renderTagPicker();
            renderRecipients();
          },
        });
      }),
    );
  }


  /* ----------------------------------------------------------------- drafts */

  const draftBadge = el('span.muted', { style: { fontSize: '11.5px' } });
  const draftNameInput = el('input', {
    type: 'text',
    placeholder: 'Draft name (optional)',
    value: state.draftName,
    oninput: (event) => {
      state.draftName = event.target.value;
      markDirty();
    },
  });

  function markDirty() {
    if (state.draftId) state.dirty = true;
    refreshDraftBadge();
  }

  function refreshDraftBadge() {
    if (!state.draftId) {
      draftBadge.textContent = 'Not saved as a draft yet';
      return;
    }
    const when = state.draftSavedAt ? formatDate(state.draftSavedAt) : '';
    draftBadge.textContent = state.dirty ? `Unsaved changes · saved ${when}` : `Draft saved ${when}`;
  }

  /** Everything the drafts API needs, built from current state. */
  function draftPayload() {
    return {
      name: state.draftName,
      subject: state.subject,
      html: editor.getHtml(),
      fromName: state.fromName,
      personalize: state.personalize,
      delayMs: state.delayMs,
      tags: state.selectedTags,
      manual: state.manual,
      selectedIds: state.selectedIds instanceof Set ? [...state.selectedIds] : [],
      attachmentIds: state.attachments.map((a) => a.id),
    };
  }

  async function saveDraftToServer({ quiet = false } = {}) {
    try {
      const payload = draftPayload();
      const result = state.draftId
        ? await put(`/api/drafts/${state.draftId}`, payload)
        : await post('/api/drafts', payload);

      state.draftId = result.draft.id;
      state.draftName = result.draft.name;
      state.draftSavedAt = result.draft.updatedAt;
      state.dirty = false;
      if (!draftNameInput.value) draftNameInput.value = result.draft.name;
      refreshDraftBadge();
      if (!quiet) toast(`Draft saved as “${result.draft.name}”.`, 'ok');
      return result.draft;
    } catch (err) {
      toast(`Could not save the draft: ${err.message}`, 'error', 8000);
      return null;
    }
  }

  /** Load a saved draft into the editor. */
  async function loadDraftIntoComposer(id) {
    try {
      const loaded = await get(`/api/drafts/${id}`);
      state.draftId = loaded.id;
      state.draftName = loaded.name;
      state.draftSavedAt = loaded.updatedAt;
      state.subject = loaded.subject;
      state.fromName = loaded.fromName;
      state.personalize = loaded.personalize;
      state.delayMs = loaded.delayMs;
      state.selectedTags = loaded.tags ?? [];
      state.manual = loaded.manual ?? '';
      // A draft saved before the checkbox picker stored a mode instead of ids.
      state.selectedIds = Array.isArray(loaded.selectedIds) ? new Set(loaded.selectedIds) : null;
      state.legacyRecipientMode = loaded.selectedIds?.length ? 'none' : (loaded.recipientMode ?? 'none');
      state.attachments = await attachmentsByIds(loaded.attachmentIds ?? []);
      state.dirty = false;

      subjectInput.value = loaded.subject;
      fromInput.value = loaded.fromName;
      delayInput.value = String(loaded.delayMs);
      personalizeCheck.checked = loaded.personalize;
      draftNameInput.value = loaded.name;
      manualBox.value = state.manual;
      editor.setHtml(loaded.html);

      renderTagPicker();
      renderRecipients();
      renderAttachments();
      refreshDraftBadge();
      refreshSendButton();
      schedulePreview();
      toast(`Loaded draft “${loaded.name}”.`, 'ok');
    } catch (err) {
      toast(`Could not load that draft: ${err.message}`, 'error', 8000);
    }
  }

  async function newDraft() {
    if (state.dirty) {
      const confirmed = await confirmDiscard();
      if (!confirmed) return;
    }
    state.draftId = null;
    state.draftName = '';
    state.draftSavedAt = null;
    state.dirty = false;
    state.subject = '';
    state.html = STARTERS['Blank HTML'];
    state.attachments = [];
    state.fromName = '';
    state.campaignName = '';
    state.selectedIds = new Set();
    state.search = '';
    state.selectedTags = [];
    state.manual = '';

    subjectInput.value = '';
    fromInput.value = '';
    campaignInput.value = '';
    draftNameInput.value = '';
    manualBox.value = '';
    recipientSearch.value = '';
    editor.setHtml(state.html);
    renderTagPicker();
    renderRecipients();
    renderAttachments();
    refreshDraftBadge();
    refreshSendButton();
    toast('Started a new draft.', 'info');
  }

  function confirmDiscard() {
    return new Promise((resolve) => {
      const dialog = openModal({
        title: 'Discard unsaved changes?',
        size: 'narrow',
        body: el('p', { text: 'This draft has changes that have not been saved. Starting a new message will lose them.' }),
        footer: [
          el('button.btn', { type: 'button', onclick: () => { dialog.close(); resolve(false); } }, 'Keep editing'),
          el('button.btn.btn-danger', {
            type: 'button',
            onclick: async () => {
              dialog.close();
              resolve(true);
            },
          }, 'Discard changes'),
        ],
      });
    });
  }

  /* ------------------------------------------------------------ attachments */

  const attachmentList = el('div', { style: { display: 'grid', gap: '6px' } });
  const attachmentSummary = el('div.muted', { style: { fontSize: '11.5px' } });
  const fileInput = el('input', {
    type: 'file',
    multiple: true,
    style: { display: 'none' },
  });

  function humanSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function attachmentsByIds(ids) {
    if (!ids.length) return [];
    try {
      const data = await get('/api/attachments');
      const byId = new Map(data.attachments.map((a) => [a.id, a]));
      return ids.map((id) => byId.get(Number(id))).filter(Boolean);
    } catch {
      return [];
    }
  }

  function renderAttachments() {
    const total = state.attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);

    mount(
      attachmentList,
      state.attachments.length
        ? state.attachments.map((file) =>
            el('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '9px',
                padding: '7px 10px',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                background: 'var(--surface-2)',
              },
            }, [
              el('span', { text: '📎' }),
              el('div', { style: { flex: '1', minWidth: '0' } }, [
                el('div.truncate', { title: file.filename, style: { fontSize: '12.5px', fontWeight: '600' }, text: file.filename }),
                el('div.muted', { style: { fontSize: '11px' }, text: `${humanSize(file.size)} · ${file.contentType ?? 'file'}` }),
              ]),
              el('button.btn.btn-sm.btn-ghost', {
                type: 'button',
                title: 'Remove this attachment',
                onclick: () => {
                  state.attachments = state.attachments.filter((a) => a.id !== file.id);
                  markDirty();
                  renderAttachments();
                  refreshSendButton();
                },
              }, '✕'),
            ]),
          )
        : el('div.muted', { style: { fontSize: '12px' } }, 'No attachments. Files are shared by every recipient.'),
    );

    attachmentSummary.textContent = state.attachments.length
      ? `${state.attachments.length} file${state.attachments.length === 1 ? '' : 's'} · ${humanSize(total)} total — attached to every message`
      : '';
  }

  async function uploadFiles(files) {
    const list = [...(files ?? [])];
    if (!list.length) return;

    const form = new FormData();
    for (const file of list) form.append('files', file);

    try {
      const response = await fetch('/api/attachments', { method: 'POST', body: form });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? `Upload failed (${response.status})`);

      state.attachments = [...state.attachments, ...payload.attachments];
      markDirty();
      renderAttachments();
      refreshSendButton();
      toast(`Attached ${payload.attachments.length} file${payload.attachments.length === 1 ? '' : 's'}.`, 'ok');
      for (const bad of payload.rejected ?? []) toast(bad.reason, 'warn', 9000);
    } catch (err) {
      toast(err.message, 'error', 9000);
    } finally {
      fileInput.value = '';
    }
  }

  fileInput.addEventListener('change', () => uploadFiles(fileInput.files));

  const attachButton = el('button.btn.btn-sm', {
    type: 'button',
    onclick: () => fileInput.click(),
  }, '📎 Attach files');

  /* -------------------------------------------------------------------- send */

  function refreshSendButton() {
    const count = state.recipients.length;
    const configured = store.health?.configured;
    sendButton.textContent = state.sending ? 'Sending…' : `Send to ${count} ${count === 1 ? 'person' : 'people'}`;
    sendButton.disabled = state.sending || !count;
    testButton.disabled = state.sending || !configured;
  }

  async function handleSend() {
    ensureSelection();
    const recipients = selectedRecipients()
      .map((c) => ({ id: c.id ?? null, name: c.name, email: c.email, company: c.company }))
      .filter((c) => /.+@.+\..+/.test(c.email));

    if (!recipients.length) {
      toast('No one is selected. Tick the contacts you want, or type addresses in “Extra addresses”.', 'error', 7000);
      return;
    }
    if (!state.subject.trim() && !state.html.trim()) {
      toast('Add a subject or some HTML before sending.', 'error');
      return;
    }

    const confirm = openModal({
      title: 'Ready to send?',
      size: 'narrow',
      body: el('div', null, [
        el('div.alert.alert-info', null, [
          el('strong', { text: `${recipients.length} ${recipients.length === 1 ? 'message' : 'messages'}` }),
          ` will be sent one at a time${state.delayMs ? ` with a ${state.delayMs} ms pause` : ''}.`,
        ]),
        el('dl.kv', null, [
          el('dt', { text: 'Subject' }),
          el('dd', { text: state.subject || '(rendered per contact)' }),
          el('dt', { text: 'Personalized' }),
          el('dd', { text: state.personalize ? 'Yes — {{name}}, {{first_name}}, …' : 'No — identical for everyone' }),
          el('dt', { text: 'Sending via' }),
          el('dd', { text: store.health?.transport?.label ?? 'unknown' }),
          el('dt', { text: 'Attachments' }),
          el('dd', {
            text: state.attachments.length
              ? `${state.attachments.length} file(s), ${humanSize(state.attachments.reduce((s, a) => s + (a.size ?? 0), 0))} on every message`
              : 'None',
          }),
        ]),
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => confirm.close() }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: () => {
            confirm.close();
            doSend(recipients);
          },
        }, 'Yes, send now'),
      ],
    });
  }

  async function doSend(recipients) {
    state.sending = true;
    refreshSendButton();

    try {
      const result = await post('/api/send', {
        subject: state.subject,
        html: editor.getHtml(),
        recipients,
        personalize: state.personalize,
        delayMs: state.delayMs,
        campaignName: state.campaignName,
        fromName: state.fromName,
        attachmentIds: state.attachments.map((a) => a.id),
      });

      if (result.invalidSkipped) {
        toast(`${result.invalidSkipped} address(es) skipped as invalid.`, 'warn');
      }
      const attached = result.attachmentCount ? ` with ${result.attachmentCount} attachment(s)` : '';
      toast(`Sending started — ${recipients.length} messages queued${attached}.`, 'ok');
      openProgressDialog(result.job);
    } catch (err) {
      toast(err.message, 'error', 7000);
      state.sending = false;
      refreshSendButton();
    }
  }

  function openProgressDialog(initialJob) {
    const bar = el('div.progress-fill');
    const track = el('div.progress-track', null, bar);
    const counters = el('div.row', { style: { margin: '12px 0' } });
    const log = el('div.job-log');
    const statusLine = el('div.soft', { style: { marginBottom: '8px' } });
    const cancelButton = el('button.btn.btn-danger', { type: 'button' }, 'Stop sending');
    let jobId = initialJob.id;

    const dialog = openModal({
      title: 'Sending messages',
      body: el('div', null, [
        el('div', { id: 'progress-summary' }, [statusLine, track, counters]),
        log,
      ]),
      footer: [el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close'), cancelButton],
      size: 'wide',
    });

    cancelButton.addEventListener('click', async () => {
      cancelButton.disabled = true;
      try {
        await post(`/api/jobs/${jobId}/cancel`);
        toast('Stopping after the current message…', 'warn');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    const renderJob = (job) => {
      statusLine.textContent = `${job.processed} of ${job.total} processed · ${job.sent} sent · ${job.failed} failed${
        job.status === 'running' && job.current ? ` · now sending to ${job.current.email}` : ''
      }`;
      bar.style.width = `${job.percent}%`;
      bar.classList.toggle('done', job.status !== 'running');
      cancelButton.disabled = job.status !== 'running' && job.status !== 'queued' && job.status !== 'cancelling';

      mount(
        counters,
        [
          ['Sent', job.sent, 'green'],
          ['Failed', job.failed, 'red'],
          ['Skipped', job.skipped, ''],
          ['Status', job.status, ''],
        ].map(([label, value, cls]) =>
          el('div', null, [
            el(`div${cls ? `.value.${cls}` : '.value'}`, {
              style: { fontSize: '18px', fontWeight: '680' },
              text: String(value),
            }),
            el('div.muted', { style: { fontSize: '11px', textTransform: 'uppercase' }, text: label }),
          ]),
        ),
      );

      mount(
        log,
        job.entries.slice(0, 400).map((entry) =>
          el('div.line', null, [
            statusBadge(entry.status),
            el('span.who', null, [
              entry.name ? el('strong', { text: entry.name }) : null,
              el('span.mono', { text: entry.name ? ` <${entry.email}>` : entry.email }),
            ]),
            entry.error ? el('span.err.truncate', { title: entry.error, text: entry.error }) : null,
            entry.sentAt ? el('span.muted.nowrap', { text: formatDate(entry.sentAt) }) : null,
          ]),
        ),
      );

      if (job.status !== 'running' && job.status !== 'queued' && job.status !== 'cancelling') {
        state.sending = false;
        refreshSendButton();
        refreshHealth().catch(() => {});
        const summary = job.status === 'completed' ? 'Sending complete' : `Sending ${job.status}`;
        toast(`${summary}: ${job.sent} sent, ${job.failed} failed.`, job.failed ? 'warn' : 'ok', 6000);
      }
    };

    renderJob(initialJob);

    const source = new EventSource(`/api/events?job=${encodeURIComponent(jobId)}`);
    source.addEventListener('progress', (event) => {
      const job = JSON.parse(event.data);
      jobId = job.id;
      renderJob(job);
      if (job.status !== 'running' && job.status !== 'queued' && job.status !== 'cancelling') {
        source.close();
      }
    });
    source.onerror = () => {
      // Fall back to polling if the stream drops.
      source.close();
      const poll = setInterval(async () => {
        try {
          const job = await get(`/api/jobs/${jobId}`);
          renderJob(job);
          if (job.status !== 'running' && job.status !== 'queued' && job.status !== 'cancelling') {
            clearInterval(poll);
          }
        } catch {
          clearInterval(poll);
        }
      }, 2000);
    };
    dialog.modal.addEventListener('remove', () => source.close());
  }

  function openTestDialog() {
    const toInput = el('input', { type: 'email', placeholder: 'you@example.com' });
    const subjInput = el('input', { type: 'text', value: state.subject || 'MailBlast test message' });
    const dialog = openModal({
      title: 'Send a test message',
      size: 'narrow',
      body: el('div', null, [
        el('div.alert.alert-info', { text: 'Sends the current subject and HTML to one address, with test values for the placeholders.' }),
        el('div.field', null, [el('label', { text: 'Send to' }), toInput]),
        el('div.field', null, [el('label', { text: 'Subject' }), subjInput]),
      ]),
      footer: [
        el('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: async (event) => {
            event.target.disabled = true;
            event.target.textContent = 'Sending…';
            try {
              const result = await post('/api/send/test', {
                to: toInput.value.trim(),
                subject: subjInput.value,
                html: state.html,
              });
              if (result.ok) {
                toast('Test message sent.', 'ok');
                dialog.close();
                refreshHealth().catch(() => {});
              } else {
                toast(result.error, 'error', 8000);
                event.target.disabled = false;
                event.target.textContent = 'Send test';
              }
            } catch (err) {
              toast(err.message, 'error', 8000);
              event.target.disabled = false;
              event.target.textContent = 'Send test';
            }
          },
        }, 'Send test'),
      ],
    });
  }

  /* ----------------------------------------------------------------- assemble */

  renderTagPicker();
  renderRecipients();
  renderAttachments();
  refreshDraftBadge();
  refreshSendButton();
  schedulePreview();

  const attachmentsCard = el('div.card', null, [
    el('div.card-head', null, [
      el('h2', { text: 'Attachments' }),
      el('div.spacer'),
      attachButton,
      fileInput,
    ]),
    el('div.card-body', null, [
      el('div', {
        style: {
          border: '1.5px dashed var(--border-strong)',
          borderRadius: '10px',
          padding: '14px',
          textAlign: 'center',
          background: 'var(--surface-2)',
          cursor: 'pointer',
          marginBottom: '10px',
        },
        onclick: () => fileInput.click(),
        ondragover: (event) => {
          event.preventDefault();
          event.currentTarget.style.borderColor = 'var(--accent)';
        },
        ondragleave: (event) => {
          event.currentTarget.style.borderColor = '';
        },
        ondrop: (event) => {
          event.preventDefault();
          event.currentTarget.style.borderColor = '';
          uploadFiles(event.dataTransfer?.files);
        },
      }, [
        el('div', { style: { fontSize: '13px', fontWeight: '600' }, text: 'Drop files here, or click to choose' }),
        el('div.muted', { style: { fontSize: '11.5px', marginTop: '3px' }, text: 'Up to 25 MB each, 40 MB total. Every recipient receives the same files.' }),
      ]),
      attachmentList,
      el('div', { style: { marginTop: '8px' } }, [attachmentSummary]),
    ]),
  ]);

  const editorCard = el('div.card', null, [
    el('div.card-head', null, [
      el('h2', { text: 'Message' }),
      el('div.spacer'),
      templateSelect,
    ]),
    el('div.card-body', null, [
      el('div.field', null, [
        el('label', { text: 'Campaign name (optional)' }),
        campaignInput,
        el('div.help', { text: 'Groups this send together in the history view.' }),
      ]),
      el('div.field', null, [
        el('label', { text: 'Subject' }),
        subjectInput,
        el('div.help', { html: 'Use <span class="mono">{{first_name}}</span> and friends to personalize each subject line.' }),
      ]),
      el('div.field', null, [
        el('label', { text: 'From name (optional)' }),
        fromInput,
      ]),
      el('div.field', null, [
        el('label', { text: 'Message' }),
        editor.node,
        el('div.help', {
          html: 'Write it as it will look. Use <strong>Personalize…</strong> in the toolbar to drop in <span class="mono">{{first_name}}</span> and friends.',
        }),
      ]),
    ]),
  ]);

  const previewCard = el('div.card', null, [
    el('div.card-head', null, [
      el('h2', { text: 'Live preview' }),
      el('div.spacer'),
      el('span.muted', { style: { fontSize: '11.5px' }, text: 'per recipient' }),
    ]),
    el('div.card-body', null, [
      previewSubject,
      previewWho,
      el('div', { style: { marginTop: '10px' } }, [
        el('div.tabs', null, [
          el('button.tab.active', {
            type: 'button',
            onclick: (event) => {
              event.target.parentElement.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
              event.target.classList.add('active');
              previewFrame.style.display = '';
              plainPreview.style.display = 'none';
            },
          }, 'HTML'),
          el('button.tab', {
            type: 'button',
            onclick: (event) => {
              event.target.parentElement.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
              event.target.classList.add('active');
              previewFrame.style.display = 'none';
              plainPreview.style.display = '';
            },
          }, 'Plain text'),
        ]),
        previewFrame,
        plainPreview,
      ]),
    ]),
  ]);

  const recipientsCard = el('div.card', null, [
    el('div.card-head', null, [
      el('h2', { text: 'Recipients' }),
      el('div.spacer'),
      el('span.muted', { style: { fontSize: '11.5px' }, text: 'tick who should receive this' }),
    ]),
    el('div.card-body', null, [
      el('div.field', null, [
        el('label', { text: 'Search contacts' }),
        el('div.search-input', null, [recipientSearch]),
      ]),
      el('div.field', null, [
        el('label', { text: 'Filter by tag (optional)' }),
        tagBox,
      ]),
      el('div.toolbar', { style: { marginBottom: '8px' } }, [
        el('label.check', { style: { alignItems: 'center' } }, [selectAllCheck, selectAllLabel]),
        el('div', { style: { flex: '1' } }),
        clearCountButton,
      ]),
      recipientsList,
      el('div', { style: { marginTop: '14px', borderTop: '1px solid var(--border)', paddingTop: '14px' } }, [
        recipientsSummary,
      ]),
      el('div.field', { style: { marginTop: '12px' } }, [
        el('label', { text: 'Extra addresses (optional)' }),
        manualBox,
        el('div.help', { text: 'Comma, semicolon, space or newline separated. These have no name, so {{name}} falls back to the part before @.' }),
      ]),
    ]),
  ]);

  const sendCard = el('div.card', null, [
    el('div.card-head', null, [el('h2', { text: 'Send' })]),
    el('div.card-body', null, [
      el('div.check', { style: { marginBottom: '12px' } }, [
        personalizeCheck,
        el('label', {
          onclick: () => {
            personalizeCheck.checked = !personalizeCheck.checked;
            personalizeCheck.dispatchEvent(new Event('change'));
          },
          html: 'Personalize each message <span class="muted">— replaces {{name}}, {{first_name}}, {{company}}, …</span>',
        }),
      ]),
      el('div.field', null, [
        el('label', { text: 'Pause between messages (ms)' }),
        delayInput,
        el('div.help', { text: 'A small delay keeps you within most providers’ rate limits and looks less like a blast.' }),
      ]),
      el('div.toolbar', { style: { marginTop: '16px' } }, [sendButton]),
      el('div.toolbar', { style: { marginTop: '8px' } }, [testButton]),
      !store.health?.configured
        ? el('div.alert.alert-warn', { style: { marginTop: '14px' }, html: 'No mail server yet. Open <a href="#/settings">Settings</a> to add SMTP or switch on <strong>capture mode</strong> to test without sending.' })
        : store.health?.transport?.kind === 'capture'
          ? el('div.alert.alert-warn', { style: { marginTop: '14px' }, text: 'Capture mode is on — messages are written to data/outbox instead of being delivered.' })
          : null,
      progressPanel,
    ]),
  ]);

  const view = el('div', null, [
    el('div.page-head', null, [
      el('div', null, [
        el('h1', { text: 'Compose' }),
        el('div.sub', { text: 'Write HTML once, personalize automatically for every recipient.' }),
      ]),
      el('div.spacer', null, [draftBadge]),
      el('div.actions', null, [
        el('button.btn.btn-sm.btn-primary', {
          type: 'button',
          title: 'Save this message as a draft',
          onclick: () => saveDraftToServer(),
        }, '💾 Save draft'),
        el('button.btn.btn-sm', {
          type: 'button',
          title: 'Start a blank message',
          onclick: newDraft,
        }, 'New'),
        el('a.btn.btn-sm', { href: '#/drafts' }, 'Open drafts'),
        el('button.btn.btn-ghost.btn-sm', {
          type: 'button',
          onclick: async () => {
            await loadContacts();
            renderRecipients();
            refreshSendButton();
            toast('Contact list reloaded.', 'ok');
          },
        }, '↻ Reload contacts'),
      ]),
    ]),
    el('div.card', { style: { marginBottom: '16px' } }, [
      el('div.card-body', null, [
        el('div.field', null, [
          el('label', { text: 'Draft name' }),
          draftNameInput,
          el('div.help', { text: 'Used to find this message again on the Drafts page. Saving a draft never sends anything.' }),
        ]),
      ]),
    ]),
    el('div.compose-layout', null, [
      el('div', { style: { display: 'grid', gap: '16px', alignContent: 'start' } }, [
        editorCard,
        attachmentsCard,
        recipientsCard,
        sendCard,
      ]),
      el('div', { style: { display: 'grid', gap: '16px', alignContent: 'start' } }, [previewCard]),
    ]),
  ]);

  view.addEventListener('route:enter', () => {
    refreshSettings().then(() => refreshSendButton()).catch(() => {});
    refreshSendButton();
  });

  // A draft requested in the URL wins over the local autosave.
  if (requestedDraftId) {
    await loadDraftIntoComposer(requestedDraftId);
  }

  return view;
}
