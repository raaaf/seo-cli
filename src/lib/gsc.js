import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
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

  // First run: open browser for auth
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\nOpen this URL in your browser to authorize GSC access:\n');
  console.log(authUrl);
  console.log('');

  const code = await prompt('Paste the authorization code here: ');
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens), 'utf8');
  console.log('Token saved to', TOKEN_PATH);

  return oAuth2Client;
}

function prompt(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', data => resolve(data.trim()));
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
