import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { execFile } from 'child_process';
import { subDays, format } from '../lib/date.js';

const TOKEN_PATH = join(homedir(), '.seo-cli-token.json');
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
let cachedAuth;

export async function getAuth() {
  if (cachedAuth) return cachedAuth;

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');

  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read Google credentials at ${credentialsPath}: ${e.message}`);
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
      throw new Error(`Failed to read OAuth token at ${TOKEN_PATH}: ${e.message}`);
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
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>seo-cli authorized. You can close this tab.</h2></body></html>');
      server.close();
      if (code) resolve(code); else reject(new Error('No code in redirect'));
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

const gscCache = new Map();

async function gscQuery(gscProperty, dimensions, { days = 28, lag = 7, rowLimit = 200 } = {}) {
  const cacheKey = JSON.stringify({ gscProperty, dimensions, days, lag, rowLimit });
  if (gscCache.has(cacheKey)) return gscCache.get(cacheKey);
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });
  const endDate = format(subDays(new Date(), lag));
  const startDate = format(subDays(new Date(), lag + days));
  const res = await sc.searchanalytics.query({
    siteUrl: gscProperty,
    requestBody: { startDate, endDate, dimensions, rowLimit },
  });
  gscCache.set(cacheKey, res.data.rows || []);
  return gscCache.get(cacheKey);
}

export async function querySearchAnalytics(gscProperty, { days = 28, lag = 7, rowLimit = 200 } = {}) {
  const rows = await gscQuery(gscProperty, ['query'], { days, lag, rowLimit });
  return rows.map(r => ({
    keyword: r.keys[0],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position,
  }));
}

export async function queryPagePerformance(gscProperty, { days = 28, lag = 7 } = {}) {
  return gscQuery(gscProperty, ['page', 'query'], { days, lag, rowLimit: 500 });
}
