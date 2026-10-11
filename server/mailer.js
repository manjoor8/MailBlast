import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { DATA_DIR, getSetting, setSetting } from './db.js';
import { htmlToText } from './personalize.js';
import { getOAuthStore, provisionCallback } from './oauth.js';

export const SMTP_SETTING_KEY = 'smtp';

const DEFAULTS = {
  host: '',
  port: 587,
  secure: false,
  user: '',
  password: '',
  fromName: '',
  fromEmail: '',
  replyTo: '',
  /** 'password' (basic SMTP AUTH) or 'oauth2' (Microsoft XOAUTH2). */
  authType: 'password',
  oauthClientId: '',
  oauthClientSecret: '',
  oauthTenant: 'common',
  oauthScope: '',
  /** When true, mail is written to data/outbox instead of being delivered. */
  captureMode: false,
};

/** Config as stored, including the secret. Server-side use only. */
export function getSmtpConfig() {
  return { ...DEFAULTS, ...(getSetting(SMTP_SETTING_KEY, {}) ?? {}) };
}

/** Config safe to send to the browser: secrets become presence flags. */
export function getPublicSmtpConfig() {
  const { password, oauthClientSecret, ...rest } = getSmtpConfig();
  return {
    ...rest,
    hasPassword: Boolean(password),
    hasOAuthClientSecret: Boolean(oauthClientSecret),
  };
}

export function saveSmtpConfig(patch = {}) {
  const current = getSmtpConfig();
  const next = { ...current };

  for (const key of [
    'host',
    'user',
    'fromName',
    'fromEmail',
    'replyTo',
    'oauthClientId',
    'oauthClientSecret',
    'oauthTenant',
    'oauthScope',
  ]) {
    if (patch[key] !== undefined) next[key] = String(patch[key] ?? '').trim();
  }
  if (patch.port !== undefined) next.port = Number(patch.port) || 587;
  if (patch.secure !== undefined) next.secure = Boolean(patch.secure);
  if (patch.captureMode !== undefined) next.captureMode = Boolean(patch.captureMode);
  if (patch.authType === 'oauth2' || patch.authType === 'password') next.authType = patch.authType;

  // An empty password means "leave the stored one alone", so the browser never
  // has to round-trip the secret back to the server.
  if (typeof patch.password === 'string' && patch.password.length > 0) {
    next.password = patch.password;
  }
  if (patch.clearPassword === true) next.password = '';
  if (typeof patch.oauthClientSecret === 'string' && patch.oauthClientSecret.length > 0) {
    next.oauthClientSecret = patch.oauthClientSecret;
  }
  if (patch.clearOAuthClientSecret === true) next.oauthClientSecret = '';

  setSetting(SMTP_SETTING_KEY, next);
  return next;
}

export function isTransportConfigured() {
  const cfg = getSmtpConfig();
  if (cfg.captureMode) return true;
  if (!cfg.host) return false;
  // An OAuth connection is only usable once the mailbox has been signed in.
  if (cfg.authType === 'oauth2') return Boolean(cfg.oauthClientId && getOAuthStore().refreshToken);
  return true;
}

export function describeTransport() {
  const cfg = getSmtpConfig();
  if (cfg.captureMode) {
    return { kind: 'capture', label: 'Capture mode — saved to data/outbox, not delivered' };
  }
  if (!cfg.host) return { kind: 'none', label: 'Not configured' };

  if (cfg.authType === 'oauth2') {
    const connected = Boolean(getOAuthStore().refreshToken);
    const account = getOAuthStore().account;
    return {
      kind: 'smtp',
      label: `SMTP ${cfg.host}:${cfg.port} (OAuth2${connected ? ` · ${account || 'connected'}` : ' · not signed in'})`,
      authType: 'oauth2',
      connected,
    };
  }

  return {
    kind: 'smtp',
    label: `SMTP ${cfg.host}:${cfg.port}${cfg.secure ? ' (TLS)' : ''}`,
    authType: 'password',
    connected: true,
  };
}

let cached = null;

function buildTransport() {
  const cfg = getSmtpConfig();

  if (cfg.captureMode) {
    const outbox = path.join(DATA_DIR, 'outbox');
    fs.mkdirSync(outbox, { recursive: true });
    return {
      kind: 'capture',
      transport: nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'unix',
      }),
      outbox,
      cfg,
    };
  }

  if (!cfg.host) {
    throw Object.assign(new Error('SMTP is not configured yet. Open Settings and add your mail server.'), {
      code: 'ESMTPNOTCONFIGURED',
      status: 400,
    });
  }

  const options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 45_000,
    tls: { minVersion: 'TLSv1.2' },
  };
  if (cfg.authType === 'oauth2') {
    // Microsoft XOAUTH2.
    //
    // The OAuth fields must sit at the TOP LEVEL of `auth`. nodemailer's
    // getAuth() copies `options.auth` keys onto its XOAuth2 options object, so a
    // nested `auth.oauth2` object is copied as a single opaque property and
    // XOAuth2 never sees refreshToken/clientId. It then fails with the very
    // unhelpful "Can't create new access token for user", and provisionCallback
    // is never invoked. Both shapes were tested against the live SMTP server:
    // flat authenticates, nested does not.
    const store = getOAuthStore();
    options.auth = {
      type: 'OAuth2',
      user: cfg.user,
      clientId: cfg.oauthClientId,
      clientSecret: cfg.oauthClientSecret || undefined,
      refreshToken: store.refreshToken,
      accessToken: store.accessToken || undefined,
      expires: store.expiresAt ? new Date(store.expiresAt).getTime() : undefined,
      provisionCallback,
    };
  } else if (cfg.user) {
    options.auth = { user: cfg.user, pass: cfg.password };
  }

  return { kind: 'smtp', transport: nodemailer.createTransport(options), cfg };
}

/** Return a cached transport, rebuilding it after any config change. */
export function getTransport() {
  if (!cached) cached = buildTransport();
  return cached;
}

export function resetTransport() {
  if (cached?.transport?.close) {
    try {
      cached.transport.close();
    } catch {
      /* ignore */
    }
  }
  cached = null;
}

/** Build the RFC-shaped envelope for one rendered message. */
export function buildMail({ to, toName, subject, html, plainText, cfg, attachments }) {
  const fromEmail = cfg.fromEmail || cfg.user;
  if (!fromEmail) {
    throw Object.assign(
      new Error('No sender address set. Add "From email" in Settings before sending.'),
      { code: 'ENOFROM', status: 400 },
    );
  }

  const from = cfg.fromName ? `"${String(cfg.fromName).replace(/"/g, '')}" <${fromEmail}>` : fromEmail;
  const text = (plainText ?? '').trim() || htmlToText(html);

  return {
    from,
    to: toName ? `"${String(toName).replace(/"/g, '')}" <${to}>` : to,
    replyTo: cfg.replyTo || undefined,
    subject,
    html,
    text,
    attachments: attachments?.length ? attachments : undefined,
    headers: {
      'X-Mailer': 'MailBlast',
      'List-Unsubscribe': cfg.replyTo ? `<mailto:${cfg.replyTo}?subject=unsubscribe>` : undefined,
    },
  };
}

/** Persist a capture-mode message so nothing is lost while testing. */
export function persistCaptured(info, envelope) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTo = String(envelope.to ?? 'unknown').replace(/[^a-z0-9@._-]/gi, '_');
  const file = path.join(cached.outbox, `${stamp}__${safeTo}.eml`);
  const raw = Buffer.isBuffer(info.message) ? info.message : Buffer.from(String(info.message ?? ''));
  fs.writeFileSync(file, raw);
  return file;
}

/** Verify credentials/host reachability without sending anything. */
export async function verifyTransport() {
  const active = getTransport();
  if (active.kind === 'capture') {
    return { ok: true, kind: 'capture', message: 'Capture mode is on — mail is written to data/outbox.' };
  }
  await active.transport.verify();
  return { ok: true, kind: 'smtp', message: `Connected to ${active.cfg.host}:${active.cfg.port}.` };
}
