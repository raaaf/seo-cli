import { google } from 'googleapis';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { subDays, format } from '../lib/date.js';

const TOKEN_PATH = join(homedir(), '.seo-cli-token.json');
// Full webmasters scope: covers read (Search Analytics) AND write (sitemap submit).
// Re-authorize / re-mint the OAuth token after changing this so it carries write access.
const SCOPES = ['https://www.googleapis.com/auth/webmasters'];
let cachedAuth;

export async function getAuth() {
  if (cachedAuth) return cachedAuth;

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');

  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read Google credentials at ${credentialsPath}: ${e.message}`, { cause: e });
  }

  // Service account
  if (credentials.type === 'service_account') {
    cachedAuth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: SCOPES,
    });
    return cachedAuth;
  }

  // OAuth2 desktop app
  const oauthConfig = credentials.installed || credentials.web;
  if (!oauthConfig) {
    throw new Error(`Invalid Google credentials at ${credentialsPath}: missing "installed" or "web" key`);
  }
  const { client_secret, client_id, redirect_uris } = oauthConfig;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (existsSync(TOKEN_PATH)) {
    try {
      oAuth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf8')));
    } catch (e) {
      throw new Error(`Failed to read OAuth token at ${TOKEN_PATH}: ${e.message}`, { cause: e });
    }
    cachedAuth = oAuth2Client;
    return cachedAuth;
  }

  // First run: start local server to catch redirect, open browser
  const code = await getCodeViaLocalServer(oAuth2Client, client_id, client_secret);
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens), { encoding: 'utf8', mode: 0o600 });
  console.log('Token saved.');

  cachedAuth = oAuth2Client;
  return cachedAuth;
}

function getCodeViaLocalServer(oAuth2Client, client_id, client_secret) {
  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString('hex');

    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>seo-cli authorized. You can close this tab.</h2></body></html>');
      server.close();
      if (returnedState !== state) {
        reject(new Error('OAuth state mismatch'));
      } else if (code) {
        resolve(code);
      } else {
        reject(new Error('No code in redirect'));
      }
    });

    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;

      // Recreate client with loopback redirect
      const loopback = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${port}`);
      Object.assign(oAuth2Client, loopback);

      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        redirect_uri: `http://localhost:${port}`,
        state,
      });

      console.log('\nOpening browser for Google authorization...');
      const platform = process.platform;
      const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
      const args = platform === 'win32' ? ['/c', 'start', '', authUrl] : [authUrl];
      execFile(opener, args, () => {});
    });

    server.on('error', reject);
  });
}

// Turn a Google auth failure into an actionable hint, or null if it is not one.
// OAuth tokens from a Testing-mode app expire roughly weekly (invalid_grant);
// surface the fix instead of a raw googleapis stack.
export function describeAuthError(e) {
  const msg = String(e?.message || e?.response?.data?.error || e?.response?.data?.error_description || '');
  if (/invalid_grant|invalid_token|token has been expired|unauthorized_client|invalid_rapt/i.test(msg)) {
    return `Google auth token rejected (${msg}). Delete ${TOKEN_PATH} and re-run to re-authorize, ` +
      `or switch to a service account (point GOOGLE_APPLICATION_CREDENTIALS at its JSON and grant it access to the property).`;
  }
  return null;
}

export function rethrowWithAuthHint(e) {
  const hint = describeAuthError(e);
  if (hint) throw new Error(hint, { cause: e });
  throw e;
}

const gscCache = new Map();

/**
 * `pageFilter` narrows the query to URLs containing that string, server-side.
 *
 * This matters for a domain property that covers several sites: without it the
 * row limit is spent on whichever host has the most traffic, and the project's
 * own pages never make the list. Harmless for a URL-prefix property, where
 * every row already belongs to the site.
 */
export function buildRequestBody({ startDate, endDate, dimensions, rowLimit, pageFilter }) {
  const body = { startDate, endDate, dimensions, rowLimit };
  if (pageFilter) {
    body.dimensionFilterGroups = [{
      filters: [{ dimension: 'page', operator: 'contains', expression: pageFilter }],
    }];
  }
  return body;
}

async function gscQuery(gscProperty, dimensions, { days = 28, lag = 7, rowLimit = 200, pageFilter = null } = {}) {
  const cacheKey = JSON.stringify({ gscProperty, dimensions, days, lag, rowLimit, pageFilter });
  if (gscCache.has(cacheKey)) return gscCache.get(cacheKey);
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });
  const endDate = format(subDays(new Date(), lag));
  const startDate = format(subDays(new Date(), lag + days));
  let res;
  try {
    res = await sc.searchanalytics.query({
      siteUrl: gscProperty,
      requestBody: buildRequestBody({ startDate, endDate, dimensions, rowLimit, pageFilter }),
    });
  } catch (e) {
    rethrowWithAuthHint(e);
  }
  gscCache.set(cacheKey, res.data.rows || []);
  return gscCache.get(cacheKey);
}

// The API's own ceiling per request. Page+query rows are what every ranking and
// score in this CLI is computed from, so the query asks for all of them: at 500
// the response was cut off mid-result set and the callers aggregated a biased
// sample. A page whose impressions spread over many long-tail queries lost most
// of its rows, so `improve` scored it as tiny and rewrote a weaker page instead.
const GSC_MAX_ROWS = 25000;

// Truncation is invisible in the payload, so say it out loud rather than let a
// growing site quietly reintroduce the sampling bug.
function warnIfTruncated(rows, label) {
  if (rows.length >= GSC_MAX_ROWS) {
    console.warn(chalk.yellow(`  GSC returned the maximum of ${GSC_MAX_ROWS} ${label} rows — the result set is truncated and every aggregate below is a sample.`));
  }
}

// Query discovery's candidate band is position 8-25 with low clicks, and Google
// sorts by clicks descending, so those candidates sit in the tail of the result
// set. The default used to be 200, which cut discovery off before it ever saw them.
export async function querySearchAnalytics(gscProperty, { days = 28, lag = 7, rowLimit = GSC_MAX_ROWS, pageFilter = null } = {}) {
  const rows = await gscQuery(gscProperty, ['query'], { days, lag, rowLimit, pageFilter });
  warnIfTruncated(rows, 'query');
  return rows.map(r => ({
    keyword: r.keys[0],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position,
  }));
}

export async function queryPagePerformance(gscProperty, { days = 28, lag = 7, pageFilter = null } = {}) {
  const rows = await gscQuery(gscProperty, ['page', 'query'], { days, lag, rowLimit: GSC_MAX_ROWS, pageFilter });
  warnIfTruncated(rows, 'page/query');
  return rows;
}

// (Re)submit a sitemap to Google Search Console. Needs the full webmasters scope
// AND the auth account being an owner/full user of the property — otherwise 403.
export async function submitSitemap(gscProperty, sitemapUrl) {
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });
  try {
    await sc.sitemaps.submit({ siteUrl: gscProperty, feedpath: sitemapUrl });
  } catch (e) {
    rethrowWithAuthHint(e);
  }
}
