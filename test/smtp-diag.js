/**
 * SMTP-over-OAuth diagnostics.
 *
 * Exercises the real transport against the configured server using the stored
 * tokens, reporting exactly what the SMTP server says. Nothing is sent: the
 * connection is opened, authenticated, and closed.
 *
 * Run with:  node test/smtp-diag.js
 */

process.env.DATA_DIR = process.env.DATA_DIR || 'D:\\Code\\SendMail\\data';

const nodemailer = await import('nodemailer');
const { getSmtpConfig, resetTransport } = await import('../server/mailer.js');
const { getOAuthStore, getAccessToken } = await import('../server/oauth.js');

const cfg = getSmtpConfig();
const store = getOAuthStore();

console.log('\n--- target ---');
console.log('host:', cfg.host, 'port:', cfg.port, 'secure:', cfg.secure, 'user:', cfg.user);

/* 1. Mint a token explicitly so a token problem is separate from an SMTP problem. */
console.log('\n--- step 1: access token ---');
let token;
try {
  token = await getAccessToken({ force: true });
  console.log('token acquired, length:', token.length);
} catch (err) {
  console.log('FAILED to get a token:', err.message);
  process.exit(1);
}

/* 2. Authenticate with XOAUTH2 and no token provider, so a refresh cannot mask
      the server's actual response. */
console.log('\n--- step 2: SMTP AUTH XOAUTH2 (fixed token) ---');
const direct = nodemailer.default.createTransport({
  host: cfg.host,
  port: cfg.port,
  secure: cfg.secure,
  connectionTimeout: 20_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
  logger: false,
  auth: {
    type: 'OAuth2',
    user: cfg.user,
    accessToken: token,
  },
});

try {
  await direct.verify();
  console.log('SUCCESS — the mailbox authenticated.');
} catch (err) {
  console.log('FAILED');
  console.log('  code    :', err.code);
  console.log('  command :', err.command);
  console.log('  response:', err.response);
  console.log('  message :', err.message);
} finally {
  direct.close();
}

/* 3. Exercise the app's own transport, which uses provisionCallback. */
console.log('\n--- step 3: app transport (provisionCallback) ---');
resetTransport();
const { getTransport } = await import('../server/mailer.js');
const active = getTransport();

if (active.kind !== 'smtp') {
  console.log('transport is not SMTP:', active.kind);
} else {
  try {
    await active.transport.verify();
    console.log('SUCCESS — the app transport authenticated.');
  } catch (err) {
    console.log('FAILED');
    console.log('  code    :', err.code);
    console.log('  command :', err.command);
    console.log('  response:', err.response);
    console.log('  message :', err.message);
  } finally {
    active.transport.close();
  }
}

console.log('\n--- token freshness ---');
const fresh = getOAuthStore();
console.log('expiresAt:', fresh.expiresAt);
console.log('now      :', new Date().toISOString());
console.log('account  :', fresh.account ?? store.account);

process.exit(0);
