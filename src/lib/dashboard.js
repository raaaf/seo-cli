import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadKeywords, KEYWORD_STATUS } from './keywords.js';

// Minimal RFC-4180-ish CSV parser (handles quoted fields written by track.js).
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toRecords(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// Collapse duplicate url|query rows (track.js appends, so a same-day re-run
// can write the same row twice). Last occurrence wins.
function dedupeRows(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.url}|${r.query}`, r);
  return [...byKey.values()];
}

function normalizeRow(r) {
  return {
    date: r.date,
    url: r.url,
    query: r.query,
    position: parseFloat(r.position),
    impressions: parseInt(r.impressions, 10) || 0,
    clicks: parseInt(r.clicks, 10) || 0,
    ctr: parseFloat(r.ctr) || 0,
  };
}

// Build snapshot metrics + week-over-week movers from the stored rankings CSVs.
function rankingStats(projectPath) {
  const dir = join(projectPath, 'seo/rankings');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith('.csv'));
  const rows = [];
  for (const f of files) {
    for (const rec of toRecords(readFileSync(join(dir, f), 'utf8'))) {
      if (rec.date && Number.isFinite(parseFloat(rec.position))) rows.push(normalizeRow(rec));
    }
  }
  if (!rows.length) return null;

  const dates = [...new Set(rows.map(r => r.date))].sort();
  const latest = dates[dates.length - 1];
  const earliest = dates[0];
  const latestRows = dedupeRows(rows.filter(r => r.date === latest));

  const movers = [];
  if (dates.length >= 2) {
    const key = r => `${r.url}|${r.query}`;
    const first = new Map(dedupeRows(rows.filter(r => r.date === earliest)).map(r => [key(r), r]));
    for (const r of latestRows) {
      const f = first.get(key(r));
      if (f) movers.push({ query: r.query, url: r.url, from: f.position, to: r.position, delta: f.position - r.position });
    }
    movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  return { ...snapshotMetrics(latestRows), snapshotDate: latest, earliestDate: earliest, dateCount: dates.length, movers, live: false };
}

function snapshotMetrics(rows) {
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const avgPos = rows.length ? rows.reduce((s, r) => s + r.position, 0) / rows.length : null;
  return { rows, impressions, clicks, avgPos, ctr: impressions ? clicks / impressions : 0 };
}

// Derive actionable next steps from funnel + snapshot.
function buildSuggestions({ counts, backlog, rank, cutoff }) {
  const out = [];

  if (rank && rank.rows.length) {
    const bestByQuery = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const prev = m.get(r.query);
        if (!prev || r.impressions > prev.impressions) m.set(r.query, r);
      }
      return [...m.values()];
    };

    const nearPage1 = bestByQuery(rank.rows.filter(r => r.position >= 8 && r.position <= 20))
      .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
      .slice(0, 3);
    for (const r of nearPage1) {
      out.push({ kind: 'near_page1', text: `Push "${r.query}" (pos ${r.position.toFixed(0)}, ${r.impressions} impr) onto page 1` });
    }

    const zeroClick = bestByQuery(rank.rows.filter(r => r.impressions >= 10 && r.clicks === 0))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 2);
    for (const r of zeroClick) {
      out.push({ kind: 'zero_click', text: `0 clicks on "${r.query}" despite ${r.impressions} impr (pos ${r.position.toFixed(0)}) — improve title/meta` });
    }

    const dropped = (rank.movers || []).filter(m => m.delta <= -5).slice(0, 2);
    for (const m of dropped) {
      out.push({ kind: 'dropped', text: `Ranking drop: "${m.query}" ${m.from.toFixed(0)}→${m.to.toFixed(0)}` });
    }
  }

  if (backlog.length === 0) {
    out.push({ kind: 'empty_backlog', text: `Backlog empty (no proposed keyword ≥ score ${cutoff}) — run "seo run" to discover` });
  } else if (backlog.length >= 5) {
    out.push({ kind: 'big_backlog', text: `${backlog.length} keywords ready to generate (≥ score ${cutoff})` });
  }

  if (counts[KEYWORD_STATUS.VALIDATION_FAILED]) {
    out.push({ kind: 'validation_failed', text: `${counts[KEYWORD_STATUS.VALIDATION_FAILED]} keyword(s) failed validation — review or skip` });
  }

  return out;
}

// Live GSC pull replaces the stored snapshot with current positions/clicks.
async function liveSnapshot(gscProperty) {
  const { queryPagePerformance } = await import('./gsc.js');
  const rows = (await queryPagePerformance(gscProperty)).map(r => ({
    url: r.keys[0],
    query: r.keys[1],
    position: r.position,
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.ctr,
  }));
  return { ...snapshotMetrics(rows), live: true };
}

// Aggregate everything the dashboard shows for one project.
export async function projectSummary(project, { live = false } = {}) {
  const kw = loadKeywords(project.path);
  const counts = {};
  for (const k of kw.keywords) counts[k.status] = (counts[k.status] || 0) + 1;

  const cutoff = project.config.score_cutoff ?? 7;
  const backlog = kw.keywords.filter(k => k.status === KEYWORD_STATUS.PROPOSED && (k.score ?? 0) >= cutoff);

  let rank = rankingStats(project.path);
  let liveError = null;
  if (live) {
    try {
      const snap = await liveSnapshot(project.config.gsc_property);
      rank = { ...(rank || { movers: [] }), ...snap };
    } catch (e) {
      liveError = e.message;
    }
  }

  const suggestions = buildSuggestions({ counts, backlog, rank, cutoff });
  return { project, updated: kw.updated, total: kw.keywords.length, counts, backlog, rank, suggestions, liveError };
}
