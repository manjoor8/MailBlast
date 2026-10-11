/**
 * Tests for the OAuth callback's automatic tenant recovery.
 *
 * A consumer-only app registration cannot be reached through the `/common`
 * endpoint, so the callback detects that specific rejection, switches the stored
 * tenant to `consumers`, and sends the browser straight back to Microsoft. These
 * tests run the real HTTP route against the real server.
 *
 * Run with:  node test/oauth-recovery.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailblast-recovery-'));
process.env.DATA_DIR = dataDir;
process.env.PORT = '4621';

const { app } = await import('../server/routes.js');
const { getSmtpConfig, saveSmtpConfig } = await import('../server/mailer.js');
const { isConsumerAudienceError } = await import('../server/oauth.js');

const BASE = 'http://127.0.0.1:4621';
const server = app.listen(4621);

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

const AUDIENCE_ERROR =
  "The request is not valid for the application's 'userAudience' configuration. " +
  "In order to use /common/ endpoint, the application must not be configured with 'Consumer' as the user audience. " +
  "The userAudience should be configured with 'All' to use /common/ endpoint.";

/** Call the callback route and return its redirect target. */
async function callback(query) {
  const response = await fetch(`${BASE}/api/oauth/microsoft/callback?${new URLSearchParams(query)}`, {
    redirect: 'manual',
  });
  return { status: response.status, location: response.headers.get('location') ?? '' };
}

console.log('\nMailBlast OAuth tenant recovery\n');

await test('the consumer-audience signature is recognised', () => {
  assert.equal(isConsumerAudienceError(AUDIENCE_ERROR), true);
  assert.equal(
    isConsumerAudienceError("the application must not be configured with 'Consumer' as the user audience. The userAudience should be configured with 'All'"),
    true,
    'the fallback signature must also be recognised',
  );
  assert.equal(isConsumerAudienceError('AADSTS50011: redirect URI mismatch'), false);
  assert.equal(isConsumerAudienceError(''), false);
  assert.equal(isConsumerAudienceError(undefined), false);
  assert.equal(isConsumerAudienceError('The user cancelled the sign-in'), false);
});

await test('a consumer-only rejection automatically retries against the consumers tenant', async () => {
  saveSmtpConfig({ authType: 'oauth2', oauthClientId: 'client-abc', oauthTenant: 'common' });
  assert.equal(getSmtpConfig().oauthTenant, 'common');

  const { status, location } = await callback({ error: 'invalid_request', error_description: AUDIENCE_ERROR });

  assert.equal(status, 302, 'should redirect rather than render an error');
  // Microsoft's own /consumers endpoint then bounces to login.live.com.
  assert.match(location, /\/consumers\/oauth2\/v2\.0\/authorize/, `should retry on the consumers tenant, got ${location}`);
  assert.doesNotMatch(location, /\/common\//, 'must no longer use the common tenant');

  // The new tenant must be persisted, so the next sign-in does not repeat this.
  assert.equal(getSmtpConfig().oauthTenant, 'consumers', 'the tenant must be saved as consumers');
});

await test('the retry carries a valid PKCE challenge and state', async () => {
  saveSmtpConfig({ oauthTenant: 'common' });
  const { location } = await callback({ error: 'invalid_request', error_description: AUDIENCE_ERROR });
  const params = new URL(location).searchParams;

  assert.equal(params.get('client_id'), 'client-abc');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok(params.get('code_challenge'), 'a fresh PKCE challenge is required');
  assert.ok(params.get('state'), 'a fresh state value is required');
  assert.equal(params.get('redirect_uri'), 'http://localhost:4621/api/oauth/microsoft/callback');
});

await test('the retry does not loop forever when the flag is present', async () => {
  saveSmtpConfig({ oauthTenant: 'common' });
  const { location } = await callback({
    error: 'invalid_request',
    error_description: AUDIENCE_ERROR,
    retried: '1',
  });

  assert.doesNotMatch(location, /login\.live\.com/, 'must not bounce back to Microsoft again');
  assert.match(location, /oauth_error=/, 'should surface the error instead');
  assert.match(decodeURIComponent(location), /How to fix it/, 'and still include the guidance');
});

await test('an unrelated error is reported, not auto-retried', async () => {
  saveSmtpConfig({ oauthTenant: 'common' });
  const { location } = await callback({
    error: 'invalid_request',
    error_description: "The provided value for the input parameter 'redirect_uri' is not valid.",
  });

  assert.match(location, /oauth_error=/, 'a redirect URI problem needs the user to act');
  assert.doesNotMatch(location, /login\.live\.com/, 'must not silently retry');
  assert.equal(getSmtpConfig().oauthTenant, 'common', 'the tenant must be left alone');
});

await test('a user cancelling consent is reported without a retry', async () => {
  const { location } = await callback({ error: 'access_denied', error_description: 'The user cancelled' });
  assert.match(location, /oauth_error=/);
  assert.match(decodeURIComponent(location), /declined the consent/i);
});

server.close();
await new Promise((resolve) => setTimeout(resolve, 200));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
