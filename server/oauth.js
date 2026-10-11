import crypto from 'node:crypto';
import { getSetting, setSetting, nowIso } from './db.js';
import { getSmtpConfig, saveSmtpConfig } from './mailer.js';

/**
 * Microsoft (Entra ID) OAuth2 / XOAUTH2 support.
 *
 * Uses the authorization-code flow with PKCE, which Microsoft supports for both
 * work/school tenants and personal Outlook.com / Live / Hotmail accounts. The
 * resulting access token is used for SMTP `AUTH XOAUTH2`.
 *
 * Reference: Microsoft's "Authenticate an IMAP, POP or SMTP connection using OAuth"
 * — delegated permission `SMTP.Send`, and PKCE is sufficient for a public client.
 */

const AUTHORITY = 'https://login.microsoftonline.com';
const TOKEN_ENDPOINT = (tenant) => `${AUTHORITY}/${tenant}/oauth2/v2.0/token`;

/** Microsoft's documented scope for SMTP AUTH (works for consumer accounts too). */
export const DEFAULT_SCOPE = 'offline_access https://outlook.office.com/SMTP.Send';

/** Refresh 5 minutes before the token actually expires. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

const OAUTH_SETTING_KEY = 'oauth';
const PENDING_SETTING_KEY = 'oauthPending';

/* ---------------------------------------------------------------------- PKCE */

export const base64Url = (buffer) =>
  Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/* ------------------------------------------------------------------- storage */

/** Persisted connection state, including the secret tokens. Server-side only. */
export function getOAuthStore() {
  return getSetting(OAUTH_SETTING_KEY, {}) ?? {};
}

export function saveOAuthStore(patch) {
  const next = { ...getOAuthStore(), ...patch };
  setSetting(OAUTH_SETTING_KEY, next);
  return next;
}

export function clearOAuthStore() {
  setSetting(OAUTH_SETTING_KEY, {});
  setSetting(PENDING_SETTING_KEY, null);
}

/** OAuth-shaped config, safe to send to the browser (no secret, no tokens). */
export function getPublicOAuthConfig(req) {
  const cfg = getSmtpConfig();
  const store = getOAuthStore();
  const expiresAt = store.expiresAt ? new Date(store.expiresAt) : null;

  return {
    authType: cfg.authType === 'oauth2' ? 'oauth2' : 'password',
    clientId: cfg.oauthClientId ?? '',
    tenant: cfg.oauthTenant ?? 'common',
    scope: cfg.oauthScope || DEFAULT_SCOPE,
    hasClientSecret: Boolean(cfg.oauthClientSecret),
    connected: Boolean(store.refreshToken),
    account: store.account ?? '',
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    expired: expiresAt ? expiresAt.getTime() < Date.now() : false,
    // Computed server-side so what the UI shows is exactly what will be sent,
    // and therefore exactly what must be registered in Azure.
    redirectUri: defaultRedirectUri(req),
  };
}

export function saveOAuthConfig(patch = {}) {
  const next = {};
  if (patch.authType === 'password' || patch.authType === 'oauth2') next.authType = patch.authType;
  if (patch.clientId !== undefined) next.oauthClientId = String(patch.clientId ?? '').trim();
  if (patch.tenant !== undefined) next.oauthTenant = String(patch.tenant ?? '').trim() || 'common';
  if (patch.scope !== undefined) next.oauthScope = String(patch.scope ?? '').trim();
  if (typeof patch.clientSecret === 'string' && patch.clientSecret.length > 0) {
    next.oauthClientSecret = patch.clientSecret;
  }
  if (patch.clearClientSecret === true) next.oauthClientSecret = '';
  return saveSmtpConfig(next);
}

/* --------------------------------------------------------------- auth URLs */

export function defaultRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI;
  const host = req?.headers?.host ?? 'localhost:3210';
  // Microsoft only permits http:// for localhost, so never use 127.0.0.1 here.
  const normalised = host.replace(/^127\.0\.0\.1/, 'localhost');
  return `http://${normalised}/api/oauth/microsoft/callback`;
}

export function buildAuthUrl({ clientId, tenant, scope, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scope || DEFAULT_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTHORITY}/${tenant || 'common'}/oauth2/v2.0/authorize?${params.toString()}`;
}

/** Begin a sign-in: remembers the PKCE verifier under a random state value. */
export function beginAuth(req) {
  const cfg = getSmtpConfig();
  if (!cfg.oauthClientId) {
    throw Object.assign(new Error('Add your Application (client) ID before signing in.'), { status: 400 });
  }

  const pkce = createPkcePair();
  const state = base64Url(crypto.randomBytes(16));
  const redirectUri = defaultRedirectUri(req);

  setSetting(PENDING_SETTING_KEY, {
    state,
    verifier: pkce.verifier,
    redirectUri,
    createdAt: nowIso(),
  });

  return {
    url: buildAuthUrl({
      clientId: cfg.oauthClientId,
      tenant: cfg.oauthTenant || 'common',
      scope: cfg.oauthScope || DEFAULT_SCOPE,
      redirectUri,
      state,
      challenge: pkce.challenge,
    }),
    redirectUri,
  };
}

function consumePending(state) {
  const pending = getSetting(PENDING_SETTING_KEY, null);
  setSetting(PENDING_SETTING_KEY, null);
  if (!pending) {
    throw Object.assign(new Error('No sign-in is in progress. Start again from Settings.'), { status: 400 });
  }
  if (pending.state !== state) {
    throw Object.assign(new Error('The sign-in response did not match this request (state mismatch).'), {
      status: 400,
    });
  }
  // A pending entry older than 15 minutes is stale.
  if (Date.now() - new Date(pending.createdAt).getTime() > 15 * 60 * 1000) {
    throw Object.assign(new Error('That sign-in attempt expired. Start again from Settings.'), { status: 400 });
  }
  return pending;
}

/**
 * Microsoft's OAuth error codes are accurate but cryptic. Map the ones people
 * actually hit onto the exact thing to change, because every one of them is a
 * configuration mistake rather than a bug.
 */
const ERROR_GUIDANCE = {
  unauthorized_client:
    'This app registration is not enabled for personal Microsoft accounts, so a live.com / hotmail.com / outlook.com address cannot sign in with it. ' +
    'In the Azure portal open your app, go to Authentication → Supported account types, and choose ' +
    '"Accounts in any organizational directory and personal Microsoft accounts" (or register a new app with that option). ' +
    'If your app is "My organization only" or "Personal Microsoft accounts only", that is the cause. ' +
    'If Azure refuses that change with "Property api.requestedAccessTokenVersion is invalid", set the token version first: ' +
    'open Manifest, set "accessTokenAcceptedVersion": 2, save, and then change the account types.',
  invalid_client:
    'The Application (client) ID does not match any app registration, or the client secret is wrong or expired. ' +
    'Re-copy the Application (client) ID from the app Overview page, and issue a fresh client secret if you are using one.',
  AADSTS7000215:
    'The client secret is not being accepted. In Azure, Certificates & secrets has two columns: "Value" and "Secret ID". ' +
    'MailBlast needs the **Value**, which is shown only once when the secret is created — the Secret ID will never work. ' +
    'If the Value is already correct, the secret has expired: create a new one and paste its Value.',
  AADSTS7000222:
    'The client secret has expired. Create a new secret in Azure (Certificates & secrets) and paste its Value into MailBlast.',
  invalid_grant:
    'Microsoft rejected the authorization code. The usual causes are a redirect URI that does not exactly match the one registered in Azure, ' +
    'an expired code (sign-in took too long), or the app being single-tenant while you signed in with a different account.',
  invalid_request:
    'Microsoft rejected the request parameters. Check that the redirect URI registered in Azure is exactly the one shown in MailBlast, ' +
    'and that your app has a Web platform configured.',
  redirect_uri_mismatch:
    'The redirect URI sent does not match the one registered in Azure. Add the exact URI shown in MailBlast to your app\'s Web platform.',
  unsupported_response_type:
    'The app registration is missing a Web platform with the authorization code flow enabled. Add a Web platform under Authentication.',
  interaction_required: 'Microsoft needs you to sign in again interactively. Start the sign-in from Settings once more.',
  consent_required:
    'Consent could not be granted. A work/school tenant may require an administrator to press "Grant admin consent" for the SMTP.Send permission.',
  access_denied: 'You declined the consent prompt, so MailBlast was not granted permission to send mail.',
  invalid_resource:
    'The requested scope is not available to this app. Re-check that the SMTP.Send delegated permission was added from "Office 365 Exchange Online".',
  AADSTS50011:
    'The redirect URI does not match the one registered in Azure. Add the exact URI shown in MailBlast to your app\'s Web platform (it must use localhost, not 127.0.0.1).',
  AADSTS700016:
    'The application was not found in this directory, which usually means the app is registered in a different tenant than the account you signed in with. ' +
    'For a personal account the app must allow personal Microsoft accounts.',
  AADSTS65001: 'Consent has not been granted for this app. Sign in again and accept the prompt, or have an administrator grant consent.',
  AADSTS50020:
    'The account you used is not a member of the app\'s tenant. For a personal live.com / hotmail.com address, ' +
    'set Supported account types to include personal Microsoft accounts (and set the token version to 2 if Azure refuses that change).',
  AADSTS5000110:
    'The app registration is missing the SMTP.Send delegated permission for Office 365 Exchange Online. ' +
    'Add it under API permissions → Add a permission → APIs my organization uses → Office 365 Exchange Online → Delegated permissions → SMTP.Send.',
  AADSTS650053: 'An administrator must consent to this app using the SMTP.Send permission on your tenant.',
  AADSTS5000141:
    'The scope requested is not available to this app. Check that SMTP.Send was added as a DELEGATED permission from "Office 365 Exchange Online" ' +
    '(not Microsoft Graph), and that the Scope field in MailBlast still contains https://outlook.office.com/SMTP.Send.',
  AADSTS7000218:
    'The token request was missing a client secret or proof. Either add a client secret in Azure (Certificates & secrets) and paste it into MailBlast, ' +
    'or set Authentication → Allow public client flows to Yes so the PKCE flow can be used without one.',
};

/**
 * Append actionable guidance to a Microsoft error, if we recognise it, and
 * surface the raw code so it can be quoted when asking for help.
 */
/**
 * Detect the "consumer app cannot use /common" failure.
 *
 * This is recoverable without changing anything in Azure: the app is set to
 * personal accounts only, so the request simply has to go to the `consumers`
 * tenant instead of `common`. Recognising it lets the callback switch
 * automatically rather than making the user find a setting.
 */
export function isConsumerAudienceError(raw) {
  const text = String(raw ?? '');
  if (!text) return false;
  // Primary signal is the setting name itself; the fallback looks for the
  // distinctive pairing of "Consumer" with "All" that this message always has.
  return /userAudience/i.test(text) || (/Consumer/.test(text) && /should be configured with 'All'/.test(text));
}

export function explainOAuthError({ error, description }) {
  const raw = String(description ?? error ?? 'Unknown error');
  const code = String(error ?? '');

  // Microsoft reports a redirect-URI problem as a generic invalid_request, so
  // the description is the only signal. This is by far the most common setup
  // mistake, and the fix is precise, so special-case it.
  if (/redirect_uri/i.test(raw)) {
    return (
      `${raw} (${code || 'invalid_request'})\n\nHow to fix it: the redirect URI MailBlast sends is not registered on this app. ` +
      'In Azure, open Authentication → Add a platform → **Web** (not "Mobile and desktop applications" — that platform is rejected) ' +
      'and add the exact URI shown in the Redirect URI box in MailBlast, including http://, the port, and /api/oauth/microsoft/callback. ' +
      'It must use localhost, not 127.0.0.1, and be saved before retrying. Also check the client ID belongs to that same app.'
    );
  }

  // The /common endpoint cannot serve an app restricted to consumer accounts.
  if (isConsumerAudienceError(raw)) {
    return (
      `${raw} (${code || 'invalid_request'})\n\nHow to fix it: this is a tenant-setting mismatch, not a bug. ` +
      'Your app registration is set to personal Microsoft accounts only, which cannot be reached through the /common endpoint. ' +
      'The quickest fix is in MailBlast: set the **Tenant** field in the Microsoft sign-in card to "consumers", press ' +
      '**Save OAuth settings**, and then sign in again. ' +
      'Alternatively, in Azure change Authentication → Supported account types to "Accounts in any organizational directory and personal Microsoft accounts" ' +
      'so that /common works, and keep Tenant as "common".'
    );
  }

  let key = code;
  // An AADSTS code in the description is more specific than the generic `error`
  // value (e.g. invalid_grant covers many distinct causes), so prefer it.
  const match = /\b(AADSTS\d+)\b/.exec(raw);
  if (match && ERROR_GUIDANCE[match[1]]) key = match[1];
  else if (!ERROR_GUIDANCE[key] && match) key = match[1];

  const guidance = ERROR_GUIDANCE[key];
  if (!guidance) return raw;

  const label = code ? ` (${code})` : '';
  return `${raw}${label}\n\nHow to fix it: ${guidance}`;
}

/* ------------------------------------------------------------ token exchange */

function decodeIdToken(idToken) {
  if (!idToken) return {};
  try {
    const payload = idToken.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function readTokenResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const description =
      payload?.error_description ?? payload?.error?.message ?? payload?.error ?? text.slice(0, 300);
    throw Object.assign(new Error(explainOAuthError({ error: payload?.error, description })), {
      status: 400,
      oauthError: payload?.error ?? 'invalid_response',
    });
  }
  return payload;
}

/** @param {object} [deps] injectable for tests */
export function createOAuthClient(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const tokenEndpoint = deps.tokenEndpoint ?? TOKEN_ENDPOINT;

  return {
    /** Exchange the authorization code for tokens, then persist the connection. */
    async completeAuth(searchParams) {
      const code = String(searchParams.get('code') ?? '');
      const state = String(searchParams.get('state') ?? '');

      if (searchParams.get('error')) {
        throw Object.assign(
          new Error(
            explainOAuthError({
              error: searchParams.get('error'),
              description: searchParams.get('error_description') ?? searchParams.get('error'),
            }),
          ),
          { status: 400, oauthError: searchParams.get('error') },
        );
      }
      if (!code) {
        throw Object.assign(new Error('Microsoft did not return an authorization code.'), { status: 400 });
      }

      const pending = consumePending(state);
      const cfg = getSmtpConfig();

      const body = new URLSearchParams({
        client_id: cfg.oauthClientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        scope: cfg.oauthScope || DEFAULT_SCOPE,
      });
      // Public clients (no secret) rely on PKCE alone.
      if (cfg.oauthClientSecret) body.set('client_secret', cfg.oauthClientSecret);

      const response = await fetchImpl(tokenEndpoint(cfg.oauthTenant || 'common'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const tokens = await readTokenResponse(response);

      const claims = decodeIdToken(tokens.id_token);
      const account =
        claims.preferred_username ?? claims.upn ?? claims.email ?? cfg.user ?? cfg.fromEmail ?? '';

      // The username used for SMTP must be the UPN of the signed-in mailbox.
      const store = saveOAuthStore({
        refreshToken: tokens.refresh_token ?? getOAuthStore().refreshToken ?? '',
        accessToken: tokens.access_token,
        expiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString(),
        account,
        scope: tokens.scope ?? cfg.oauthScope ?? DEFAULT_SCOPE,
        connectedAt: nowIso(),
        error: null,
      });

      saveSmtpConfig({ authType: 'oauth2', user: account });

      return { account: store.account, expiresAt: store.expiresAt };
    },

    /** Return a usable access token, refreshing it when needed. */
    async getAccessToken({ force = false } = {}) {
      const cfg = getSmtpConfig();
      const store = getOAuthStore();

      const fresh =
        store.accessToken &&
        store.expiresAt &&
        new Date(store.expiresAt).getTime() - EXPIRY_SKEW_MS > Date.now();

      if (!force && fresh) return store.accessToken;

      if (!store.refreshToken) {
        throw Object.assign(
          new Error('Not signed in to Microsoft yet. Open Settings and connect the mailbox first.'),
          { status: 400, code: 'ENOTCONNECTED' },
        );
      }
      if (!cfg.oauthClientId) {
        throw Object.assign(new Error('The OAuth client ID is missing from Settings.'), { status: 400 });
      }

      const body = new URLSearchParams({
        client_id: cfg.oauthClientId,
        grant_type: 'refresh_token',
        refresh_token: store.refreshToken,
        scope: cfg.oauthScope || DEFAULT_SCOPE,
      });
      if (cfg.oauthClientSecret) body.set('client_secret', cfg.oauthClientSecret);

      const response = await fetchImpl(tokenEndpoint(cfg.oauthTenant || 'common'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      let tokens;
      try {
        tokens = await readTokenResponse(response);
      } catch (err) {
        saveOAuthStore({ error: err.message, accessToken: '', expiresAt: null });
        throw Object.assign(
          new Error(`${err.message} — you may need to reconnect the mailbox in Settings.`),
          { status: 400, code: 'EREFRESHFAILED' },
        );
      }

      saveOAuthStore({
        accessToken: tokens.access_token,
        // Microsoft rotates refresh tokens; keep the newest one.
        refreshToken: tokens.refresh_token ?? store.refreshToken,
        expiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString(),
        error: null,
      });

      return tokens.access_token;
    },
  };
}

const defaultClient = createOAuthClient();

export const completeAuth = (params) => defaultClient.completeAuth(params);
export const getAccessToken = (options) => defaultClient.getAccessToken(options);

/**
 * Token provider shaped for nodemailer's `auth.oauth2.provisionCallback`.
 * nodemailer calls this on connection and again when a token is rejected.
 */
export function provisionCallback(user, renew, callback) {
  defaultClient
    .getAccessToken({ force: Boolean(renew) })
    .then((token) => {
      const store = getOAuthStore();
      const expires = store.expiresAt ? new Date(store.expiresAt).getTime() : 0;
      callback(null, token, expires);
    })
    .catch((err) => callback(err));
}
