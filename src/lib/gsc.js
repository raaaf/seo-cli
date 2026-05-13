import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { exec } from 'child_process';
import { subDays, format } from '../lib/date.js';

const TOKEN_PATH = join(process.env.HOME, '.seo-cli-token.json');
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

export async function getAuth() {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set');

  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));

  // Service account
  if (credentials.type === 'service_account') {
    return new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: SCOPES,
    });
  }

  // OAuth2 desktop app
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf8')));
    return oAuth2Client;
  }

  // First run: start local server to catch redirect, open browser
  const code = await getCodeViaLocalServer(oAuth2Client);
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens), 'utf8');
  console.log('Token saved.');

  return oAuth2Client;
}

function getCodeViaLocalServer(oAuth2Client) {
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
      const { client_id, client_secret } = oAuth2Client._clientId
        ? { client_id: oAuth2Client._clientId, client_secret: oAuth2Client._clientSecret }
        : oAuth2Client;

      // Recreate client with loopback redirect
      const loopback = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${port}`);
      Object.assign(oAuth2Client, loopback);

      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        redirect_uri: `http://localhost:${port}`,
      });

      console.log('\nOpening browser for Google authorization...');
      exec(`open "${authUrl}"`);
    });

    server.on('error', reject);
  });
}

export async function querySearchAnalytics(gscProperty, { days = 28, lag = 7, rowLimit = 200 } = {}) {
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });

  const endDate = format(subDays(new Date(), lag));
  const startDate = format(subDays(new Date(), lag + days));

  const res = await sc.searchanalytics.query({
    siteUrl: gscProperty,
    requestBody: { startDate, endDate, dimensions: ['query'], rowLimit },
  });

  return (res.data.rows || []).map(r => ({
    keyword: r.keys[0],
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
    position: r.position,
  }));
}

export async function queryPagePerformance(gscProperty, { days = 28, lag = 7 } = {}) {
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });

  const endDate = format(subDays(new Date(), lag));
  const startDate = format(subDays(new Date(), lag + days));

  const res = await sc.searchanalytics.query({
    siteUrl: gscProperty,
    requestBody: { startDate, endDate, dimensions: ['page', 'query'], rowLimit: 500 },
  });

  return res.data.rows || [];
}
