import { el, mount, clear, get, put, post, toast, openModal } from '../lib.js';
import { refreshSettings, refreshHealth, store } from '../app.js';

const PROVIDERS = [
  { name: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 587, secure: false, note: 'Requires a 16-character App Password (2-Step Verification must be on).' },
  { name: 'Outlook.com / Live / Hotmail', host: 'smtp-mail.outlook.com', port: 587, secure: false, note: 'Microsoft account + app password. Microsoft is retiring password-based SMTP here — see the warning below.' },
  { name: 'Microsoft 365 (work/school)', host: 'smtp.office365.com', port: 587, secure: false, note: 'Tenant must allow SMTP AUTH for this mailbox; app password if MFA is on.' },
  { name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true, note: 'Full account password or app-specific password.' },
  { name: 'Mailgun', host: 'smtp.mailgun.org', port: 587, secure: false, note: 'Username is postmaster@your-domain; password is the SMTP password.' },
  { name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false, note: 'Username is literally "apikey"; password is your API key.' },
  { name: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false, note: 'Replace the region in the host with your own; use SMTP credentials.' },
  { name: 'Local test server (MailHog / Papercut)', host: '127.0.0.1', port: 1025, secure: false, note: 'No auth, no TLS — great for checking rendering.' },
];

/** Personal Microsoft mailboxes, which have their own auth caveats. */
const MICROSOFT_CONSUMER = /^(smtp-mail\.outlook\.com|smtp\.office365\.com)$/i;


/* ------------------------------------------------------ Microsoft OAuth card */

/**
 * "Sign in with Microsoft" panel. Only shown when the auth type is OAuth2.
 * The redirect back from Microsoft lands on #/settings?connected=1 (or
 * ?oauth_error=...), which app.js re-renders, so this reads those up front.
 */
function buildOAuthCard(oauth, onChanged) {
  const hashQuery = window.location.hash.includes('?')
    ? new URLSearchParams(window.location.hash.split('?')[1])
    : new URLSearchParams();

  const state = {
    clientId: oauth.clientId ?? '',
    clientSecret: '',
    tenant: oauth.tenant ?? 'common',
    scope: oauth.scope ?? '',
  };

  const clientIdInput = el('input', {
    type: 'text',
    placeholder: 'Application (client) ID — a GUID',
    value: state.clientId,
    oninput: (event) => {
      state.clientId = event.target.value.trim();
    },
  });

  const secretInput = el('input', {
    type: 'password',
    autocomplete: 'new-password',
    placeholder: oauth.hasClientSecret ? '•••••••• (stored — type to replace)' : 'Client secret value',
    oninput: (event) => {
      state.clientSecret = event.target.value;
    },
  });

  const tenantInput = el('input', {
    type: 'text',
    placeholder: 'common',
    value: state.tenant,
    oninput: (event) => {
      state.tenant = event.target.value.trim() || 'common';
    },
  });

  const scopeInput = el('input', {
    type: 'text',
    value: state.scope,
    oninput: (event) => {
      state.scope = event.target.value.trim();
    },
  });

  const statusBox = el('div');
  const redirectBox = el('div');

  // The server computes the redirect URI, so showing its value guarantees the
  // string registered in Azure is the one that will actually be sent.
  const redirectUriInput = el('input', {
    type: 'text',
    readOnly: true,
    value: oauth.redirectUri ?? '',
    onfocus: (event) => event.target.select(),
    onclick: (event) => event.target.select(),
  });

  mount(
    redirectBox,
    el('div.field', null, [
      el('label', { text: 'Redirect URI — register this exact value in Azure' }),
      redirectUriInput,
      el('div.help', {
        html: 'Add it under <strong>Authentication → Add a platform → Web</strong>. '
          + 'It must be <strong>Web</strong> — if you add it to "Mobile and desktop applications" instead, Microsoft will reject the sign-in '
          + 'with <span class="mono">redirect_uri is not valid</span>. It must also be <span class="mono">localhost</span>, not '
          + '<span class="mono">127.0.0.1</span>, and the port must match.',
      }),
    ]),
  );

  // Refresh from the API in case the page was loaded from a different host.
  fetch('/api/oauth/microsoft/status')
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (data?.redirectUri) redirectUriInput.value = data.redirectUri;
    })
    .catch(() => {});

  function renderStatus() {
    if (oauth.connected) {
      mount(
        statusBox,
        el('div.alert.alert-ok', null, [
          el('strong', { text: 'Connected. ' }),
          oauth.account ? `Signed in as ${oauth.account}.` : 'Mailbox is signed in.',
          oauth.expiresAt
            ? ` Access token ${oauth.expired ? 'has expired and will refresh automatically' : `valid until ${new Date(oauth.expiresAt).toLocaleTimeString()}`}.`
            : '',
        ]),
      );
    } else {
      mount(
        statusBox,
        el('div.alert.alert-warn', {
          text: 'Not connected yet. Fill in your client ID and secret, save, then press "Sign in with Microsoft".',
        }),
      );
    }
  }

  const saveOAuthButton = el('button.btn', { type: 'button' }, 'Save OAuth settings');
  saveOAuthButton.addEventListener('click', async () => {
    saveOAuthButton.disabled = true;
    saveOAuthButton.textContent = 'Saving…';
    try {
      await put('/api/settings', {
        smtp: { authType: 'oauth2' },
        oauth: {
          authType: 'oauth2',
          clientId: state.clientId,
          clientSecret: state.clientSecret || undefined,
          tenant: state.tenant,
          scope: state.scope,
        },
      });
      state.clientSecret = '';
      secretInput.value = '';
      toast('OAuth settings saved.', 'ok');
      onChanged();
    } catch (err) {
      toast(err.message, 'error', 7000);
    } finally {
      saveOAuthButton.disabled = false;
      saveOAuthButton.textContent = 'Save OAuth settings';
    }
  });

  const signInButton = el('button.btn.btn-primary', { type: 'button' }, 'Sign in with Microsoft');
  signInButton.addEventListener('click', async () => {
    signInButton.disabled = true;
    signInButton.textContent = 'Opening Microsoft…';
    try {
      // Persist whatever is typed before starting, so the flow uses it.
      await put('/api/settings', {
        smtp: { authType: 'oauth2' },
        oauth: {
          authType: 'oauth2',
          clientId: state.clientId,
          clientSecret: state.clientSecret || undefined,
          tenant: state.tenant,
          scope: state.scope,
        },
      });
      const { url, redirectUri } = await post('/api/oauth/microsoft/start', {});
      console.info('[MailBlast] OAuth redirect URI:', redirectUri);
      window.location.href = url;
    } catch (err) {
      toast(err.message, 'error', 9000);
      signInButton.disabled = false;
      signInButton.textContent = 'Sign in with Microsoft';
    }
  });

  const disconnectButton = el('button.btn.btn-danger', { type: 'button' }, 'Disconnect');
  disconnectButton.style.display = oauth.connected ? '' : 'none';
  disconnectButton.addEventListener('click', async () => {
    try {
      await post('/api/oauth/microsoft/disconnect', {});
      toast('Disconnected from Microsoft.', 'ok');
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  renderStatus();

  return el('div.card', null, [
    el('div.card-head', null, [
      el('h2', { text: 'Microsoft sign-in (OAuth2)' }),
      el('div.spacer'),
      el('span.muted', { style: { fontSize: '11.5px' }, text: oauth.connected ? 'signed in' : 'required for Live / Outlook.com' }),
    ]),
    el('div.card-body', null, [
      hashQuery.get('oauth_error')
        ? el('div.alert.alert-error', {
            style: { whiteSpace: 'pre-wrap' },
            text: `Microsoft sign-in failed: ${hashQuery.get('oauth_error')}`,
          })
        : null,
      statusBox,
      redirectBox,
      el('div.field', null, [
        el('label', { text: 'Application (client) ID' }),
        clientIdInput,
        el('div.help', { text: 'Azure portal → App registrations → your app → Overview → Application (client) ID.' }),
      ]),
      el('div.field', null, [
        el('label', { text: 'Client secret value' }),
        secretInput,
        el('div.help', { text: 'Certificates & secrets → New client secret. Leave blank if you enabled public client flows instead.' }),
      ]),
      el('div.row', null, [
        el('div.field', null, [
          el('label', { text: 'Tenant' }),
          tenantInput,
          el('div.help', {
            html: 'Use <span class="mono">common</span> if your app allows both work/school and personal accounts. '
              + 'Use <span class="mono">consumers</span> if the app is set to personal Microsoft accounts only — '
              + '<span class="mono">common</span> will be rejected with a <span class="mono">userAudience</span> error in that case.',
          }),
        ]),
        el('div.field', { style: { flex: '2' } }, [
          el('label', { text: 'Scope' }),
          scopeInput,
          el('div.help', { text: 'Default: offline_access https://outlook.office.com/SMTP.Send' }),
        ]),
      ]),
      el('div.toolbar', null, [saveOAuthButton, signInButton, disconnectButton]),
    ]),
  ]);
}

export async function renderSettings() {
  await refreshSettings().catch(() => {});
  const smtp = store.settings?.smtp ?? {};
  let oauthCfg = store.settings?.oauth ?? {};
  const state = {
    host: smtp.host ?? '',
    port: smtp.port ?? 587,
    secure: Boolean(smtp.secure),
    user: smtp.user ?? '',
    password: '',
    clearPassword: false,
    fromName: smtp.fromName ?? '',
    fromEmail: smtp.fromEmail ?? '',
    replyTo: smtp.replyTo ?? '',
    captureMode: Boolean(smtp.captureMode),
  };

  const fields = {};
  const make = (key, props = {}) => {
    const input = el('input', { ...props, value: props.value ?? state[key] ?? '' });
    input.addEventListener('input', () => {
      state[key] = props.type === 'number' ? Number(input.value) : input.value;
      if (key === 'host' || key === 'fromEmail') updateStatusLine();
    });
    fields[key] = input;
    return input;
  };

  const statusLine = el('div.soft');
  const microsoftNotice = el('div', {
    dataset: { notice: 'microsoft-password-deprecation' },
    style: { display: 'none' },
  });
  const fieldsHost = el('div', { style: { marginTop: '14px' } });

  function updateStatusLine() {
    const kind = state.captureMode ? 'capture' : state.host ? 'smtp' : 'none';
    mount(
      statusLine,
      el('span', null, [
        el(`span.dot.dot-${kind === 'none' ? 'bad' : kind === 'capture' ? 'warn' : 'ok'}`),
        ' ',
        kind === 'capture'
          ? 'Capture mode — mail is saved to data/outbox and never delivered.'
          : kind === 'smtp'
            ? `SMTP ${state.host}:${state.port}${state.secure ? ' with TLS' : ''}`
            : 'No mail server configured yet.',
      ]),
    );

    const isMicrosoft = MICROSOFT_CONSUMER.test(state.host ?? '');
    const showNotice = isMicrosoft && authType === 'password';
    microsoftNotice.style.display = showNotice ? '' : 'none';
    fieldsHost.style.marginTop = showNotice ? '0' : '14px';
    clear(microsoftNotice);
    if (showNotice) {
      mount(
        microsoftNotice,
        el('div.alert.alert-warn', null, [
          el('strong', { text: 'Microsoft is retiring password-based SMTP. ' }),
          'Outlook.com, Live and Hotmail mailboxes are moving to OAuth2-only, and for many accounts ',
          'SMTP AUTH can no longer be enabled at all — you will see ',
          el('span.mono', { text: '535 5.7.139 Authentication unsuccessful' }),
          ' even with a correct app password. Switch to ',
          el('strong', { text: 'Microsoft OAuth2' }),
          ' below and sign in instead.',
        ]),
      );
    }
  }

  const hostInput = make('host', { type: 'text', placeholder: 'smtp.example.com' });
  const portInput = make('port', { type: 'number', min: '1', max: '65535' });
  const userInput = make('user', { type: 'text', placeholder: 'you@example.com', autocomplete: 'off' });
  const passwordInput = make('password', {
    type: 'password',
    placeholder: smtp.hasPassword ? '•••••••• (stored — type to replace)' : 'App password or API key',
    autocomplete: 'new-password',
  });
  const fromNameInput = make('fromName', { type: 'text', placeholder: 'Ada Lovelace' });
  const fromEmailInput = make('fromEmail', { type: 'email', placeholder: 'hello@yourdomain.com' });
  const replyToInput = make('replyTo', { type: 'email', placeholder: 'support@yourdomain.com' });

  const secureCheck = el('input', {
    type: 'checkbox',
    checked: state.secure,
    onchange: (event) => {
      state.secure = event.target.checked;
      portInput.value = String(state.secure ? 465 : 587);
      state.port = state.secure ? 465 : 587;
      updateStatusLine();
    },
  });

  const captureCheck = el('input', {
    type: 'checkbox',
    checked: state.captureMode,
    onchange: (event) => {
      state.captureMode = event.target.checked;
      updateStatusLine();
    },
  });

  const saveButton = el('button.btn.btn-primary', { type: 'button' }, 'Save settings');

  /* ------------------------------ authentication mode (password vs OAuth2) */

  let authType = smtp.authType === 'oauth2' ? 'oauth2' : 'password';

  const authModeHost = el('div', { style: { marginBottom: '6px' } });
  const passwordFieldsHost = el('div');
  const oauthCardHost = el('div');

  function renderAuthMode() {
    mount(
      authModeHost,
      el('div.toolbar', null, [
        el(`button.btn.btn-sm${authType === 'password' ? '.btn-primary' : ''}`, {
          type: 'button',
          text: 'Password',
          onclick: () => {
            authType = 'password';
            renderAuthMode();
            renderAuthDependent();
          },
        }),
        el(`button.btn.btn-sm${authType === 'oauth2' ? '.btn-primary' : ''}`, {
          type: 'button',
          text: 'Microsoft OAuth2',
          onclick: () => {
            authType = 'oauth2';
            renderAuthMode();
            renderAuthDependent();
          },
        }),
      ]),
      el('div.help', {
        text:
          authType === 'oauth2'
            ? 'Sign in with Microsoft. Required for Live/Hotmail/Outlook.com, where password-based SMTP is being retired.'
            : 'Classic SMTP username + password or app password. Not accepted by most Microsoft consumer mailboxes any more.',
      }),
    );
  }

  function renderAuthDependent() {
    passwordFieldsHost.style.display = authType === 'password' ? '' : 'none';
    updateStatusLine();
  }

  // A single "auth block" that swaps between password fields and the OAuth card.
  const authBlock = el('div');
  // Defined after `mount(fieldsHost, ...)` below fills passwordFieldsHost.

  async function save() {
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      await put('/api/settings', {
        smtp: {
          host: state.host,
          port: state.port,
          secure: state.secure,
          authType,
          user: state.user,
          password: state.password || undefined,
          clearPassword: state.clearPassword,
          fromName: state.fromName,
          fromEmail: state.fromEmail,
          replyTo: state.replyTo,
          captureMode: state.captureMode,
        },
      });
      state.password = '';
      state.clearPassword = false;
      passwordInput.value = '';
      toast('Settings saved.', 'ok');
      await Promise.all([refreshSettings(), refreshHealth()]);
    } catch (err) {
      toast(err.message, 'error', 7000);
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save settings';
    }
  }

  saveButton.addEventListener('click', save);

  const testButton = el('button.btn', { type: 'button' }, 'Test connection');
  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    testButton.textContent = 'Testing…';
    const resultHost = el('div', { style: { marginTop: '10px' } });
    mount(testButton.parentElement, resultHost);
    try {
      const result = await post('/api/settings/test', {});
      mount(resultHost, el('div.alert.alert-ok', { text: result.message }));
    } catch (err) {
      mount(resultHost, el('div.alert.alert-error', { text: err.message }));
    } finally {
      testButton.disabled = false;
      testButton.textContent = 'Test connection';
    }
  });

  function openTestEmailDialog() {
    const toInput = el('input', { type: 'email', value: state.fromEmail || state.user || '', placeholder: 'you@example.com' });
    const dialog = openModal({
      title: 'Send a test email',
      size: 'narrow',
      body: el('div', null, [
        el('p.soft', { style: { marginBottom: '12px' }, text: 'This sends a real message through the settings above so you can confirm delivery.' }),
        el('div.field', null, [el('label', { text: 'Send to' }), toInput]),
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
                subject: 'MailBlast test message',
                html: `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px">
                  <h2 style="margin:0 0 8px">It works 🎉</h2>
                  <p style="color:#4a525c;line-height:1.6">Your SMTP settings are correct — MailBlast can deliver mail from this account.</p>
                  <p style="color:#8b95a3;font-size:13px">Sent ${new Date().toLocaleString()}.</p>
                </div>`,
              });
              if (result.ok) {
                toast('Test email sent — check that inbox.', 'ok');
                dialog.close();
                refreshHealth().catch(() => {});
              } else {
                toast(result.error, 'error', 9000);
                event.target.disabled = false;
                event.target.textContent = 'Send test email';
              }
            } catch (err) {
              toast(err.message, 'error', 9000);
              event.target.disabled = false;
              event.target.textContent = 'Send test email';
            }
          },
        }, 'Send test email'),
      ],
    });
  }

  // Assembled last: this block references every input and button defined above.
  mount(
    passwordFieldsHost,
    el('div.field', null, [el('label', { text: 'Username' }), userInput]),
    el('div.field', null, [
      el('label', { text: 'Password' }),
      passwordInput,
      el('div.help', { text: smtp.hasPassword ? 'A password is stored. Leave blank to keep it, or type a new one.' : 'Stored locally and never sent back to the browser.' }),
    ]),
  );

  mount(
    fieldsHost,
    el('div.row', null, [
      el('div.field', { style: { flex: '3' } }, [el('label', { text: 'SMTP host' }), hostInput]),
      el('div.field', { style: { flex: '1' } }, [el('label', { text: 'Port' }), portInput]),
    ]),
    el('div.check', { style: { marginBottom: '14px' } }, [
      secureCheck,
      el('label', {
        onclick: () => {
          secureCheck.checked = !secureCheck.checked;
          secureCheck.dispatchEvent(new Event('change'));
        },
        html: 'Use implicit TLS <span class="muted">(port 465 style; leave off for STARTTLS on 587)</span>',
      }),
    ]),
    el('div.field', null, [
      el('label', { text: 'Authentication' }),
      authModeHost,
    ]),
    passwordFieldsHost,
    el('div.row', null, [
      el('div.field', null, [el('label', { text: 'From name' }), fromNameInput]),
      el('div.field', null, [el('label', { text: 'From email' }), fromEmailInput]),
    ]),
    el('div.field', null, [el('label', { text: 'Reply-to (optional)' }), replyToInput]),
    el('div.check', { style: { margin: '14px 0' } }, [
      captureCheck,
      el('label', {
        onclick: () => {
          captureCheck.checked = !captureCheck.checked;
          captureCheck.dispatchEvent(new Event('change'));
        },
        html: 'Capture mode <span class="muted">— do not deliver anything; save each message to data/outbox so you can test safely</span>',
      }),
    ]),
    el('div.toolbar', null, [
      saveButton,
      testButton,
      el('button.btn', { type: 'button', onclick: openTestEmailDialog }, 'Send test email'),
    ]),
  );

  const providerList = el('div', { style: { display: 'grid', gap: '8px' } });
  mount(
    providerList,
    PROVIDERS.map((provider) =>
      el('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '9px 11px',
          border: '1px solid var(--border)',
          borderRadius: '8px',
        },
      }, [
        el('div', { style: { flex: '1', minWidth: '0' } }, [
          el('div', { style: { fontWeight: '600', fontSize: '13px' }, text: provider.name }),
          el('div.muted', { style: { fontSize: '11.5px' }, text: `${provider.host}:${provider.port} · ${provider.note}` }),
        ]),
        el('button.btn.btn-sm', {
          type: 'button',
          onclick: () => {
            state.host = provider.host;
            state.port = provider.port;
            state.secure = provider.secure;
            hostInput.value = provider.host;
            portInput.value = String(provider.port);
            secureCheck.checked = provider.secure;
            updateStatusLine();
            toast(`Filled in ${provider.name} settings — add your password and save.`, 'info', 5000);
          },
        }, 'Use'),
      ]),
    ),
  );

  // Set the auth mode before the first status render so it reflects reality.
  renderAuthMode();

  // OAuth card: rebuilt whenever the connection state changes.
  function mountOAuthCard() {
    mount(
      oauthCardHost,
      buildOAuthCard(oauthCfg, async () => {
        await refreshSettings();
        oauthCfg = store.settings?.oauth ?? oauthCfg;
        mountOAuthCard();
        updateStatusLine();
      }),
    );
  }
  mountOAuthCard();
  renderAuthDependent();

  const view = el('div', null, [
    el('div.page-head', null, [
      el('div', null, [
        el('h1', { text: 'Settings' }),
        el('div.sub', { text: 'Connect the mailbox MailBlast sends from. Credentials stay on this machine, in data/mailblast.db.' }),
      ]),
    ]),
    el('div.grid.grid-2', null, [
      el('div.card', null, [
        el('div.card-head', null, [el('h2', { text: 'Mail server' }), el('div.spacer'), el('span.muted', { style: { fontSize: '11.5px' }, text: 'SMTP' })]),
        el('div.card-body', null, [
          statusLine,
          el('div', { style: { marginTop: '10px' } }, [microsoftNotice]),
          fieldsHost,
        ]),
      ]),
      el('div', { style: { display: 'grid', gap: '16px', alignContent: 'start' } }, [
        oauthCardHost,
        el('div.card', null, [
          el('div.card-head', null, [el('h2', { text: 'Common providers' })]),
          el('div.card-body', null, [providerList]),
        ]),
        el('div.card', null, [
          el('div.card-head', null, [el('h2', { text: 'Deliverability checklist' })]),
          el('div.card-body', null, [
            el('ul', { style: { margin: 0, paddingLeft: '18px', lineHeight: '1.7', color: 'var(--text-soft)', fontSize: '13px' } }, [
              el('li', { text: 'Set From email to a domain you actually own — free-mail "from" addresses get filtered.' }),
              el('li', { text: 'For more than a few dozen messages a day, use a real provider (SES, Mailgun, SendGrid, Postmark) instead of a personal mailbox.' }),
              el('li', { text: 'Keep the pause between messages at 200 ms or more to stay inside provider rate limits.' }),
              el('li', { text: 'Include a physical address and an unsubscribe line if you are mailing a list.' }),
              el('li', { text: 'Warm up new domains gradually; sudden volume spikes look like spam.' }),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);

  view.addEventListener('route:enter', () => {
    updateStatusLine();
  });

  return view;
}
