import { google } from 'googleapis';
import { subDays, format } from '../lib/date.js';

export async function getAuth() {
  if (process.env.GSC_CLIENT_EMAIL && process.env.GSC_PRIVATE_KEY) {
    return new google.auth.JWT({
      email: process.env.GSC_CLIENT_EMAIL,
      key: process.env.GSC_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
  }
  return new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
}

export async function querySearchAnalytics(gscProperty, { days = 28, lag = 7, rowLimit = 200 } = {}) {
  const auth = await getAuth();
  const sc = google.searchconsole({ version: 'v1', auth });

  const endDate = format(subDays(new Date(), lag));
  const startDate = format(subDays(new Date(), lag + days));

  const res = await sc.searchanalytics.query({
    siteUrl: gscProperty,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit,
      dimensionFilterGroups: [],
    },
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
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page', 'query'],
      rowLimit: 500,
    },
  });

  return res.data.rows || [];
}
