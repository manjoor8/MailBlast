# MailBlast

A self-hosted web app for sending HTML email that is **personalized per recipient** — compose once,
import a contact list, and send one individual message at a time so every person sees their own name.

Built with Node.js + Express + `nodemailer` + SQLite. No build step, no front-end framework, no
external services: everything runs locally and your contacts and history stay on your machine.

---

## Features

| # | Requirement | How it works |
|---|---|---|
| 1 | **HTML email compose** | A visual WYSIWYG editor: write and format the message as the recipient will see it (bold/italic, headings, lists, quotes, alignment, font family/size, text and highlight colour, links, horizontal rules), with starter templates, a live sandboxed preview of the real rendered output (HTML **and** auto-generated plain text), and one-click personalization tokens. An **HTML source** tab is there for anyone who wants to hand-edit the markup, but visual editing is the default. |
| 2 | **Import contacts (Name, Email)** | CSV upload or drag-and-drop, paste straight from Excel / Google Sheets, or add contacts one by one. Columns (`Name`, `Email`, `Company`, `Tags`) are detected automatically in any order; headers are optional. Every row is validated and previewed before anything is saved. |
| 3 | **One-click send to many, personalized** | Select all contacts, filter by tag, or type a manual list, then send. Messages go out **strictly one at a time** with a configurable pause, each rendered individually from your template (`{{first_name}}`, `{{name}}`, `{{company}}`, …) with live progress, per-recipient status, and a stop button. |
| 4 | **Sent history** | Every message is recorded individually in SQLite — recipient, rendered subject, full HTML, status, error, transport and timestamp — plus campaign grouping and daily/aggregate statistics. |
| 5 | **Search sent emails** | Debounced full-text search across recipient name, email address, subject **and** body, combined with status, campaign and date-range filters, sort order, pagination, CSV export, and a full-message viewer. |
| 6 | **Saved drafts** | Save the message you are writing and come back to it later, from any browser. A draft keeps the subject, body, sender name, personalization settings, recipient selection and attachments. Manage them on the **Drafts** page: reopen, duplicate, search or delete. Saving a draft never sends anything. |
| 7 | **Attachments** | Drop files onto the composer or pick them. Every recipient gets the same files, attached to their individually personalized message. Filenames are sanitised, executable types are refused, and per-file / per-message size limits are enforced. |

Extras: capture mode (test the whole flow without sending anything), suppression list honoured
before every send, resend from history, connection test, and provider presets for Gmail, Microsoft
365, Zoho, Mailgun, SendGrid, Amazon SES and local test servers.

---

## Quick start

```bash
npm install
npm start
```

Then open **http://127.0.0.1:3210**.

### 1. Choose how mail is sent

Open **Settings** and pick an **Authentication** mode:

- **Password** — host, port, TLS, username and password/app password. Use the provider shortcuts to
  fill in known values, then press **Test connection** and **Send test email**. For Gmail you need a
  16-character App Password (2-Step Verification must be enabled).
- **Microsoft OAuth2** — required for Outlook.com / Live / Hotmail, where Microsoft is retiring
  password-based SMTP. See [Connecting a Microsoft account](#connecting-a-microsoft-account-live--outlookcom)
  below.

Either way you can also switch on **capture mode** — nothing is delivered, and every message is
written to `data/outbox/*.eml` so you can walk through the whole flow safely.

### Connecting a Microsoft account (Live / Outlook.com)

Microsoft no longer lets most personal mailboxes send with a username and password, so MailBlast
signs in with OAuth2 instead. You need an Azure app registration (free, no credit card).

**In the Azure portal** ([entra.microsoft.com](https://entra.microsoft.com) → Identity →
Applications → App registrations):

1. Open your app (or create one: **New registration**, name it anything, and for *Supported account
   types* choose **Accounts in any organizational directory and personal Microsoft accounts** if you
   want to send from a `live.com`/`hotmail.com` address).
2. Go to **Authentication** → **Add a platform** → **Web**, and add this exact redirect URI:

   ```
   http://localhost:3210/api/oauth/microsoft/callback
   ```

   It must be `localhost`, not `127.0.0.1` — Microsoft only permits `http://` for `localhost`. If you
   changed `PORT`, use that port instead. The Settings page shows you the precise value to copy.
3. Still in **Authentication**, set **Allow public client flows** to **Yes** (this is what makes the
   PKCE flow work). A client secret is then optional, but a **Web** platform normally also wants one —
   either works.
4. Go to **API permissions** → **Add a permission** → **APIs my organization uses** → search for
   **Office 365 Exchange Online** → **Delegated permissions** → tick **SMTP.Send** → **Add
   permissions**. The `offline_access` scope MailBlast requests is consented at sign-in, so you do not
   need to add it manually.
5. If your account is a work/school tenant, press **Grant admin consent**. Personal accounts don't
   need this.

**In MailBlast** (Settings → Microsoft sign-in):

6. Paste the **Application (client) ID** from the app's **Overview** page. For a personal
   Live/Hotmail account set **Tenant** to `consumers`; leave it as `common` otherwise.
7. Optionally paste a **client secret** (Certificates & secrets → New client secret) if you did not
   enable public client flows.
8. Set **SMTP host** to `smtp-mail.outlook.com`, port `587`, implicit TLS **off**, and set **From
   email** to the mailbox you are signing in as.
9. Press **Save OAuth settings**, then **Sign in with Microsoft**. After consenting you land back on
   the Settings page with a green *Connected* badge showing the signed-in address.
10. Press **Test connection**, then **Send test email**.

The access token is refreshed automatically (including mid-send if the server rejects it), and the
refresh token is stored alongside your other settings in `data/mailblast.db`.

> **Deliverability note:** even with OAuth working, a personal `live.com`/`hotmail.com` address is a
> poor choice for bulk sending — Microsoft doesn't publish free-account limits, filters aggressively,
> and your From domain won't match your sending reputation. OAuth support here is for legitimate use of
> your own mailbox; for anything list-shaped, use a transactional provider.

### 2. Import contacts

**Contacts → Import contacts.** Drop a CSV such as:

```csv
Name,Email,Company,Tags
Ada Lovelace,ada@example.com,Analytical Engines,"vip; newsletter"
Grace Hopper,grace@example.com,US Navy,vip
```

Any column order works, headers are optional, and quoted commas/newlines are handled. You get a
row-by-row preview, duplicate detection and a choice of what to do when a contact already exists
(update, skip, or replace).

### 3. Compose and send

**Compose.** Write the message in the visual editor — the toolbar covers headings, bold/italic/
underline, lists, quotes, alignment, font family and size, text and highlight colours, links and
horizontal rules. Use **Personalize…** to drop `{{first_name}}` (or any other token) into the body or
a link URL, and watch the live preview update as you type. Switch to the **HTML source** tab if you
ever want to hand-edit the markup; your content is carried across both ways.

Pick recipients, then **Send now**. Sending runs one message at a time with a progress panel streamed
live over server-sent events, showing exactly who succeeded and who failed. Guard rails: the send is
blocked if SMTP is unconfigured or the template is empty, and the final confirmation step restates the
recipient count, personalization mode and transport.

Everything you write is **sanitised before it is stored or sent**: scripts and their contents,
event handlers (`onclick`, `onerror`, …), `javascript:`/`data:` URLs, `iframe`s, forms and remote
`style`/`link` tags are all removed, while email-safe markup and inline CSS are preserved. Pasting
from a web page or Word inserts clean text by default (hold **Shift** to keep the original
formatting), which is what keeps email layout predictable across clients.

### 4. Save a draft, or attach files

**Drafts.** Give the message a name in the **Draft name** box and press **💾 Save draft** (the header shows
whether it is saved, and warns about unsaved changes). Reopen it any time from **Drafts** in the sidebar,
which lists every saved message with a search box and actions to open, duplicate or delete it. Work in
progress is also autosaved in your browser as a safety net, so an accidental refresh does not lose a
message that was never explicitly saved.

**Attachments.** Drop files onto the **Attachments** panel in the composer, or click to choose. Every
recipient receives the same files on their own personalized message. Limits are 25 MB per file and 40 MB
per message, and executables (`.exe`, `.bat`, `.ps1`, `.js`, `.msi`, …) are refused because providers block
them. Filenames are sanitised before they reach the MIME headers. Attachments are stored under
`data/attachments/` and read only at send time.

### 5. Search what you sent

**Sent history.** Type in the search box to match recipient, email, subject or body text, then narrow
by status, campaign or date range. Click any row to see the exact HTML that went out, its plain-text
version, the server reply, and to resend it.

---

## Personalization tokens

Used in both the subject and the HTML body, case-insensitive:

| Token | Becomes |
|---|---|
| `{{name}}` | Full name (`Ada Lovelace`) |
| `{{first_name}}` | First word of the name (`Ada`) |
| `{{last_name}}` | Remaining words (`Lovelace`) |
| `{{email}}` | Email address |
| `{{company}}` | Company field |
| `{{date}}` | Today's date |

If a contact has no name, `{{name}}` and `{{first_name}}` fall back to the part of the email address
before the `@`, so a message never reads "Hi ,". Unticking **Personalize each message** sends
byte-identical content to everyone and skips token substitution entirely. Unknown tokens are left
untouched rather than blanked, so a typo is visible instead of silently vanishing.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3210` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` to expose on the network) |
| `DATA_DIR` | `./data` | Where the SQLite database and capture-mode outbox live |
| `OAUTH_REDIRECT_URI` | derived from the request host | Override the Microsoft redirect URI (must match Azure exactly) |

Authentication settings are stored in `data/mailblast.db`. **The API never returns secrets to the
browser**: the SMTP password, OAuth client secret, access token and refresh token are all replaced by
presence flags, and an empty password field means "keep the existing one".

---

## Project layout

```
server/
  index.js        HTTP listener and startup banner
  routes.js       REST API: contacts, import, preview, send, jobs/SSE, history, stats, settings, OAuth
  queue.js        The one-by-one bulk sender with live progress and cancellation
  mailer.js       nodemailer transport (password or XOAUTH2), capture mode, connection test
  oauth.js        Microsoft OAuth2: PKCE, token exchange, automatic refresh, XOAUTH2 provider
  drafts.js       Saved compose drafts (list, load, save, duplicate, delete)
  attachments.js  Attachment storage, validation, MIME resolution and cleanup
  sanitize.js     Email-safe HTML allowlist used on save, preview and send
  db.js           SQLite schema and contact/settings helpers
  csv.js          CSV/TSV parser and writer (header detection, quoting, inference)
  personalize.js  Token rendering and the HTML → plain-text converter
public/
  index.html      App shell
  styles.css      Design system (no framework)
  js/lib.js       DOM builder, fetch wrapper, toasts, formatting, modal
  js/editor.js    WYSIWYG email editor (toolbar, tokens, HTML source view)
  js/csv.js       Browser-side CSV parsing for import previews
  js/views/       compose · drafts · contacts · sent · settings · query helpers
test/
  smoke.test.js             End-to-end API test (boots a real server on a scratch database)
  oauth.test.js             OAuth2/PKCE flow against a stubbed token endpoint
  oauth-recovery.test.js    Automatic tenant recovery in the OAuth callback
  drafts-attachments.test.js Drafts CRUD and the attachment pipeline
  sanitize.test.js          HTML sanitiser, including XSS and idempotency cases
  editor.test.js            WYSIWYG editor behaviour against a DOM shim
  views.test.js             Renders the real views in a DOM shim to catch blank-screen bugs
  imports.test.js           Static check that every import resolves to a real export
  browser.test.js           Headless-Chromium UI walkthrough with screenshots
  smtp-diag.js              Separates "can we mint a token?" from "can we authenticate?"
  seed.js                   Creates demo contacts and campaigns through the public API
  demo.js                   Live end-to-end demonstration against a running server
```

## Tests

```bash
npm test              # imports + OAuth2 + sanitiser + editor + drafts/attachments + API + views
npm run test:browser  # drives the real UI in headless Edge/Chrome
npm run diag:smtp     # diagnoses SMTP/OAuth authentication against the live server
```

`npm test` runs entirely offline against a throwaway database. To exercise the UI in a real browser
first start the server and seed it:

```bash
npm start
npm run seed          # 20 demo contacts + two campaigns, in capture mode
npm run test:browser  # screenshots land in test/screenshots/
```

> `test/browser.test.js` needs a Chromium browser that can open a DevTools debugging socket. Some
> sandboxed environments let the browser launch but block that socket; the test detects this and
> exits with a clear message instead of a false failure.

---

## Sending responsibly

This app will happily send to every contact you have, so a few notes:

- Set **From email** to a domain you control. Free-mail "from" addresses are frequently filtered.
- Keep the **pause between messages** at 200 ms or more. A personal mailbox (Gmail, Outlook) will
  rate-limit or lock an account that blasts hundreds of messages; for real volume use a transactional
  provider such as SES, Mailgun, SendGrid or Postmark.
- If you are mailing a list, include a physical address and a working unsubscribe route. The
  `Reply-to` setting is added as a `List-Unsubscribe` header automatically.
- Warm up new domains gradually — sudden volume spikes look like spam.
- Failed addresses are recorded with their error, and the `suppressions` table is checked before
  every send, so a hard bounce is not retried by accident.

## Security notes

MailBlast is designed as a local, single-operator tool and has **no authentication layer**. It binds
to `127.0.0.1` by default for that reason. Before exposing it on a network or hosting it, add
authentication in front of it, serve it over HTTPS, and restrict who can read `data/mailblast.db` —
it contains your SMTP password in plain text, which is the same trade-off every local mail client
makes. Email previews are rendered in sandboxed iframes with a strict Content-Security-Policy so
that neither your own HTML nor an imported template can execute scripts.
