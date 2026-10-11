/**
 * OAuth2 / XOAUTH2 tests.
 *
 * Microsoft's endpoints cannot be called from a test, so the token endpoint is
 * injected and stubbed. Everything else — PKCE, state handling, token storage,
 * refresh, and the shape handed to nodemailer — is exercised for real.
 *
 * Run with:  node test/oauth.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailblast-oauth-'));
process.env.DATA_DIR = dataDir;

const {
  createPkcePair,
  base64Url,
  buildAuthUrl,
  beginAuth,
  createOAuthClient,
  getOAuthStore,
  saveOAuthStore,
  clearOAuthStore,
  getPublicOAuthConfig,
  saveOAuthConfig,
  provisionCallback,
  DEFAULT_SCOPE,
} = await import('../server/oauth.js');
const { getSmtpConfig, getPublicSmtpConfig } = await import('../server/mailer.js');
const { getSetting } = await import('../server/db.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** Build a fake token endpoint that records what it was asked for. */
function fakeTokenEndpoint(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, options) => {
    const params = new URLSearchParams(options.body);
    calls.push({ url, method: options.method, params: Object.fromEntries(params) });
    const response = Array.isArray(responses) ? responses[Math.min(index, responses.length - 1)] : responses;
    index += 1;
    if (response.status && response.status >= 400) {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(response.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

/** A minimal unsigned JWT with the claims Microsoft would return. */
function fakeIdToken(claims) {
  const encode = (value) => base64Url(Buffer.from(JSON.stringify(value)));
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

console.log('\nMailBlast OAuth2 tests\n');

/* ---------------------------------------------------------------------- PKCE */

await test('PKCE verifier and challenge are valid base64url with a SHA-256 challenge', () => {
  const { verifier, challenge, method } = createPkcePair();

  assert.equal(method, 'S256');
  assert.match(verifier, /^[A-Za-z0-9\-_]{43,128}$/, 'verifier must be base64url and 43-128 chars');
  assert.ok(!verifier.includes('+') && !verifier.includes('/') && !verifier.includes('='), 'must be url-safe');

  const expected = base64Url(crypto.createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected, 'challenge must be the SHA-256 of the verifier');
});

await test('two PKCE pairs never collide', () => {
  const a = createPkcePair();
  const b = createPkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

/* ------------------------------------------------------------------ auth URL */

await test('the authorization URL carries every parameter Microsoft requires', () => {
  const url = new URL(
    buildAuthUrl({
      clientId: 'client-abc',
      tenant: 'consumers',
      scope: DEFAULT_SCOPE,
      redirectUri: 'http://localhost:3210/api/oauth/microsoft/callback',
      state: 'state-123',
      challenge: 'challenge-xyz',
    }),
  );

  assert.equal(url.host, 'login.microsoftonline.com');
  assert.equal(url.pathname, '/consumers/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-abc');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-xyz');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3210/api/oauth/microsoft/callback');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.match(url.searchParams.get('scope'), /SMTP\.Send/);
  assert.match(url.searchParams.get('scope'), /offline_access/);
});

await test('the default scope requests SMTP.Send and a refresh token', () => {
  assert.match(DEFAULT_SCOPE, /https:\/\/outlook\.office\.com\/SMTP\.Send/);
  assert.match(DEFAULT_SCOPE, /offline_access/);
});

/* ---------------------------------------------------------------- begin flow */

await test('sign-in requires a client ID first', () => {
  clearOAuthStore();
  saveOAuthConfig({ clientId: '', clientSecret: '' });
  assert.throws(() => beginAuth({ headers: { host: 'localhost:3210' } }), /client \(client\) ID|client\) ID/i);
});

await test('beginAuth stores a pending PKCE verifier and forces localhost', () => {
  saveOAuthConfig({ clientId: 'client-abc', tenant: 'consumers', scope: DEFAULT_SCOPE });

  const { url, redirectUri } = beginAuth({ headers: { host: '127.0.0.1:3210' } });
  const parsed = new URL(url);
  const pending = getSetting('oauthPending', null);

  assert.ok(pending, 'a pending sign-in should be stored');
  assert.equal(pending.state, parsed.searchParams.get('state'));
  assert.ok(pending.verifier.length >= 43, 'verifier should be stored for the token exchange');
  // Microsoft only accepts http:// for localhost, never 127.0.0.1.
  assert.equal(redirectUri, 'http://localhost:3210/api/oauth/microsoft/callback');
  assert.ok(!redirectUri.includes('127.0.0.1'), 'redirect URI must use localhost');
});

/* -------------------------------------------------------------- code exchange */

await test('completing sign-in exchanges the code and stores the tokens', async () => {
  saveOAuthConfig({ clientId: 'client-abc', tenant: 'consumers', scope: DEFAULT_SCOPE, authType: 'oauth2' });
  const { url } = beginAuth({ headers: { host: 'localhost:3210' } });
  const state = new URL(url).searchParams.get('state');

  const { fetchImpl, calls } = fakeTokenEndpoint({
    body: {
      access_token: 'access-token-1',
      refresh_token: 'refresh-token-1',
      expires_in: 3600,
      scope: DEFAULT_SCOPE,
      id_token: fakeIdToken({ preferred_username: 'you@live.com' }),
    },
  });

  const client = createOAuthClient({ fetch: fetchImpl, tokenEndpoint: (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token` });
  const result = await client.completeAuth(new URLSearchParams({ code: 'auth-code-1', state }));

  assert.equal(result.account, 'you@live.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.grant_type, 'authorization_code');
  assert.equal(calls[0].params.code, 'auth-code-1');
  assert.ok(calls[0].params.code_verifier, 'the PKCE verifier must be sent');
  assert.equal(calls[0].params.redirect_uri, 'http://localhost:3210/api/oauth/microsoft/callback');

  const store = getOAuthStore();
  assert.equal(store.refreshToken, 'refresh-token-1');
  assert.equal(store.accessToken, 'access-token-1');
  assert.equal(store.account, 'you@live.com');
  assert.ok(new Date(store.expiresAt).getTime() > Date.now());
});

await test('the SMTP username is set to the signed-in mailbox', () => {
  assert.equal(getSmtpConfig().user, 'you@live.com');
  assert.equal(getSmtpConfig().authType, 'oauth2');
});

await test('a mismatched state is rejected', async () => {
  saveOAuthConfig({ clientId: 'client-abc' });
  beginAuth({ headers: { host: 'localhost:3210' } });
  const client = createOAuthClient({ fetch: async () => new Response('{}', { status: 200 }) });
  await assert.rejects(
    () => client.completeAuth(new URLSearchParams({ code: 'c', state: 'wrong-state' })),
    /state mismatch/i,
  );
});

await test('an error response from Microsoft surfaces its description', async () => {
  const client = createOAuthClient({ fetch: async () => new Response('{}', { status: 200 }) });
  await assert.rejects(
    () =>
      client.completeAuth(
        new URLSearchParams({ error: 'access_denied', error_description: 'The user cancelled' }),
      ),
    /The user cancelled/,
  );
});

await test('a token error response is reported with its description', async () => {
  saveOAuthConfig({ clientId: 'client-abc' });
  const { url } = beginAuth({ headers: { host: 'localhost:3210' } });
  const state = new URL(url).searchParams.get('state');

  const client = createOAuthClient({
    fetch: async () =>
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70000: code expired' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
  });

  await assert.rejects(
    () => client.completeAuth(new URLSearchParams({ code: 'c', state })),
    /AADSTS70000/,
  );
});

/* -------------------------------------------------------------------- refresh */

await test('a cached access token is reused instead of refreshing', async () => {
  saveOAuthStore({
    accessToken: 'fresh-token',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const { fetchImpl, calls } = fakeTokenEndpoint({ body: { access_token: 'should-not-be-used', expires_in: 3600 } });
  const client = createOAuthClient({ fetch: fetchImpl });
  const token = await client.getAccessToken();

  assert.equal(token, 'fresh-token');
  assert.equal(calls.length, 0, 'no network call should happen for a valid cached token');
});

await test('an expired access token is refreshed with the refresh token', async () => {
  saveOAuthStore({
    accessToken: 'stale-token',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const { fetchImpl, calls } = fakeTokenEndpoint({
    body: { access_token: 'renewed-token', refresh_token: 'refresh-2', expires_in: 3600 },
  });
  const client = createOAuthClient({ fetch: fetchImpl });
  const token = await client.getAccessToken();

  assert.equal(token, 'renewed-token');
  assert.equal(calls[0].params.grant_type, 'refresh_token');
  assert.equal(calls[0].params.refresh_token, 'refresh-1');
  // Microsoft rotates refresh tokens, so the new one must be kept.
  assert.equal(getOAuthStore().refreshToken, 'refresh-2');
});

await test('a token close to expiry is refreshed early', async () => {
  saveOAuthStore({
    accessToken: 'about-to-expire',
    refreshToken: 'refresh-1',
    // Inside the 5-minute safety window.
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const { fetchImpl, calls } = fakeTokenEndpoint({ body: { access_token: 'early-token', expires_in: 3600 } });
  const client = createOAuthClient({ fetch: fetchImpl });
  assert.equal(await client.getAccessToken(), 'early-token');
  assert.equal(calls.length, 1, 'a nearly expired token should be refreshed');
});

await test('force=true refreshes even a valid token', async () => {
  saveOAuthStore({
    accessToken: 'valid-token',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const { fetchImpl, calls } = fakeTokenEndpoint({ body: { access_token: 'forced-token', expires_in: 3600 } });
  const client = createOAuthClient({ fetch: fetchImpl });
  assert.equal(await client.getAccessToken({ force: true }), 'forced-token');
  assert.equal(calls.length, 1);
});

await test('requesting a token without a connection gives a clear, actionable error', async () => {
  clearOAuthStore();
  saveOAuthConfig({ clientId: 'client-abc' });
  const client = createOAuthClient({ fetch: async () => new Response('{}', { status: 200 }) });
  await assert.rejects(() => client.getAccessToken(), /not signed in|connect the mailbox/i);
});

await test('a failed refresh tells the user to reconnect', async () => {
  saveOAuthStore({ accessToken: '', refreshToken: 'dead-refresh', expiresAt: null });
  const client = createOAuthClient({
    fetch: async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(() => client.getAccessToken(), /reconnect the mailbox/i);
  assert.match(getOAuthStore().error, /refresh token expired/);
});

/* ------------------------------------------------------- nodemailer integration */

await test('provisionCallback gives nodemailer a token with an expiry', async () => {
  saveOAuthStore({
    accessToken: 'nm-token',
    refreshToken: 'refresh-1',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const result = await new Promise((resolve, reject) => {
    provisionCallback('you@live.com', false, (err, token, expires) => {
      if (err) reject(err);
      else resolve({ token, expires });
    });
  });

  assert.equal(result.token, 'nm-token');
  assert.ok(result.expires > Date.now(), 'nodemailer needs a future expiry');
});

await test('the transport is built with OAuth2 auth when the mode is oauth2', async () => {
  const { resetTransport, getTransport, saveSmtpConfig } = await import('../server/mailer.js');
  saveSmtpConfig({
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    authType: 'oauth2',
    oauthClientId: 'client-abc',
    user: 'you@live.com',
  });
  resetTransport();
  const auth = getTransport().transport.options.auth;

  assert.equal(auth.type, 'OAuth2');
  assert.equal(auth.user, 'you@live.com');

  // nodemailer copies only the TOP LEVEL keys of `auth` onto its XOAuth2 options,
  // so these must not be nested under auth.oauth2 — doing that made every send
  // fail with "Can't create new access token for user".
  assert.equal(auth.clientId, 'client-abc', 'clientId must be a top-level auth key');
  assert.equal(auth.refreshToken, 'refresh-1', 'refreshToken must be a top-level auth key');
  assert.equal(typeof auth.provisionCallback, 'function', 'provisionCallback must be a top-level auth key');
  assert.ok(!auth.oauth2, 'a nested oauth2 object is ignored by nodemailer and must not be used');
  assert.ok(!('pass' in auth), 'no password should be sent in OAuth mode');
});

/* ------------------------------------------------------------------- secrecy */

await test('the client secret and tokens are never exposed to the browser', () => {
  saveOAuthConfig({ clientId: 'client-abc', clientSecret: 'super-secret-value' });
  saveOAuthStore({ accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: null });

  const smtp = getPublicSmtpConfig();
  const oauth = getPublicOAuthConfig();
  const serialised = JSON.stringify({ smtp, oauth });

  assert.ok(!serialised.includes('super-secret-value'), 'client secret leaked to the client');
  assert.ok(!serialised.includes('secret-access'), 'access token leaked to the client');
  assert.ok(!serialised.includes('secret-refresh'), 'refresh token leaked to the client');
  assert.equal(smtp.oauthClientSecret, undefined);
  assert.equal(smtp.hasOAuthClientSecret, true);
  assert.equal(oauth.hasClientSecret, true);
  assert.equal(oauth.connected, true);
});

await test('an unconfigured OAuth transport is not treated as ready to send', async () => {
  clearOAuthStore();
  saveOAuthConfig({ clientId: '', clientSecret: '' });
  const { saveSmtpConfig, resetTransport, isTransportConfigured } = await import('../server/mailer.js');
  saveSmtpConfig({ host: 'smtp-mail.outlook.com', authType: 'oauth2', captureMode: false });
  resetTransport();
  assert.equal(isTransportConfigured(), false, 'OAuth2 without a signed-in mailbox must not look configured');
});

/* ------------------------------------------------------------- error guidance */

await test('an unauthorized_client error explains the Azure account-type fix', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');

  const message = explainOAuthError({
    error: 'unauthorized_client',
    description: 'The client does not exist or is not enabled for consumers.',
  });

  assert.match(message, /not enabled for personal Microsoft accounts/);
  assert.match(message, /Supported account types/, 'the message must name the exact Azure setting');
  assert.match(message, /organizational directory and personal Microsoft accounts/);
  assert.match(message, /unauthorized_client/, 'the raw code should be preserved for quoting');
  // Changing the account type can itself be blocked by an invalid token version,
  // which sent real users down a dead end, so the fix must be mentioned too.
  assert.match(message, /accessTokenAcceptedVersion/, 'the token-version prerequisite must be explained');
  assert.match(message, /Manifest/, 'the message must say where to set the token version');
});

await test('an AADSTS code buried in the description is recognised', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');

  const message = explainOAuthError({
    error: 'invalid_grant',
    description: 'AADSTS50011: The redirect URI specified in the request does not match the redirect URIs configured for the application.',
  });

  assert.match(message, /redirect URI does not match/, 'guidance should be based on the AADSTS code');
});

await test('an unrecognised error is passed through unchanged', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');
  const raw = 'Something entirely unexpected happened.';
  assert.equal(explainOAuthError({ error: 'weird_error', description: raw }), raw);
});

await test('an unauthorized_client response from the callback carries the fix', async () => {
  saveOAuthConfig({ clientId: 'client-abc' });
  const client = createOAuthClient({ fetch: async () => new Response('{}', { status: 200 }) });

  await assert.rejects(
    () =>
      client.completeAuth(
        new URLSearchParams({
          error: 'unauthorized_client',
          error_description: 'The client does not exist or is not enabled for consumers.',
        }),
      ),
    (err) => {
      assert.match(err.message, /Supported account types/);
      assert.equal(err.oauthError, 'unauthorized_client');
      return true;
    },
  );
});

await test('a redirect_uri rejection explains the Web platform requirement', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');

  const message = explainOAuthError({
    error: 'invalid_request',
    description: "The provided value for the input parameter 'redirect_uri' is not valid. The expected value is a URI which matches a redirect URI registered for this client application.",
  });

  assert.match(message, /not registered on this app/, 'the cause must be stated plainly');
  assert.match(message, /Web/, 'must tell the user which platform to use');
  assert.match(message, /Mobile and desktop applications/, 'must warn about the platform that gets rejected');
  assert.match(message, /localhost/, 'must warn against 127.0.0.1');
  assert.match(message, /api\/oauth\/microsoft\/callback/, 'must name the exact path');
  assert.match(message, /redirect_uri/, 'the raw description should still be present');
});

await test('the status payload reports the exact redirect URI that will be sent', async () => {
  const { getPublicOAuthConfig } = await import('../server/oauth.js');

  const fromLoopback = getPublicOAuthConfig({ headers: { host: '127.0.0.1:3210' } });
  assert.equal(fromLoopback.redirectUri, 'http://localhost:3210/api/oauth/microsoft/callback');

  const fromLocalhost = getPublicOAuthConfig({ headers: { host: 'localhost:3210' } });
  assert.equal(fromLocalhost.redirectUri, fromLoopback.redirectUri);

  const customPort = getPublicOAuthConfig({ headers: { host: 'localhost:8080' } });
  assert.equal(customPort.redirectUri, 'http://localhost:8080/api/oauth/microsoft/callback');

  // The UI reads this value, so the page can never show a URI that differs
  // from the one actually sent to Microsoft.
  assert.ok(!fromLoopback.redirectUri.includes('127.0.0.1'), 'Must never use 127.0.0.1');
});

await test('a userAudience rejection explains the /common vs consumers mismatch', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');

  const message = explainOAuthError({
    error: 'invalid_request',
    description: "The request is not valid for the application's 'userAudience' configuration. In order to use /common/ endpoint, the application must not be configured with 'Consumer' as the user audience. The userAudience should be configured with 'All' to use /common/ endpoint.",
  });

  // The generic "check the redirect URI" text must NOT be shown for this error.
  assert.ok(!/redirect URI/i.test(message), 'must not misattribute this to the redirect URI');
  assert.match(message, /Tenant/, 'must point at the Tenant setting');
  assert.match(message, /consumers/, 'must name the value to use');
  assert.match(message, /personal Microsoft accounts only/, 'must explain the cause');
  assert.match(message, /Supported account types/, 'must offer the Azure-side alternative');
});

await test('the consumer-audience error is not confused with a redirect URI error', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');

  // A redirect URI error must still get redirect guidance.
  const redirect = explainOAuthError({ error: 'invalid_request', description: "parameter 'redirect_uri' is not valid" });
  assert.match(redirect, /redirect URI/);

  // And an audience error must get audience guidance, even though both are invalid_request.
  const audience = explainOAuthError({ error: 'invalid_request', description: "not valid for the application's 'userAudience' configuration" });
  assert.match(audience, /tenant-setting mismatch/);
  assert.ok(!/Redirect URI box/.test(audience), 'must not suggest registering a redirect URI');
});

await test('an invalid client secret error explains Value vs Secret ID', async () => {
  const { explainOAuthError } = await import('../server/oauth.js');

  const message = explainOAuthError({
    error: 'invalid_client',
    description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app 'abc'.",
  });

  assert.match(message, /AADSTS7000215/, 'the AADSTS code takes precedence over the generic error');
  assert.match(message, /\*\*Value\*\*|Value/, 'must name the column to copy');
  assert.match(message, /Secret ID/, 'must warn about the column that never works');
  assert.match(message, /shown only once/, 'must warn the Value is only visible at creation');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
