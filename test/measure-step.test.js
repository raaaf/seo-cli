import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const queryPageTotals = vi.fn();
vi.mock('../src/lib/gsc.js', () => ({ queryPageTotals: (...a) => queryPageTotals(...a) }));

vi.mock('../src/lib/safe-fetch.js', () => ({ assertPublicUrl: vi.fn(async () => {}) }));

const { resetRybbitGuard } = await import('../src/lib/rybbit.js');
const { measure } = await import('../src/steps/measure.js');
const { windowsFor } = await import('../src/lib/measure.js');
const { loadChanges, saveChanges, CHANGES_FILE } = await import('../src/lib/changes.js');

const CONFIG = {
  gsc_property: 'sc-domain:a.de', base_url: 'https://a.de', locales: ['de'], landing_path: 'content/de/',
  counterpart_locale: 'en', counterpart_url_prefix: '/en',
};
const MERGED = '2026-08-01';
const TODAY = '2026-10-20'; // both readings are due
const W = windowsFor(MERGED);
const CONTROLS = Array.from({ length: 14 }, (_, i) => `control-${i}`);

let dir, warnings;
const run = (opts = {}) => measure({ config: CONFIG, cwd: dir, warnings, today: TODAY, ...opts });
const url = (slug) => `https://a.de/${slug}`;

function entry(over = {}) {
  return {
    id: 'pr1', kind: 'rewrite', slug: 'target', urls: [url('target')], pr_url: 'pr1', merged_at: MERGED,
    baseline: null, readings: { d28: null, d56: null }, revert_candidate: false, ...over,
  };
}
const seed = (...entries) => saveChanges({ entries }, dir);

// GSC answers per window: { baseline|d28|d56: { 'https://a.de/slug': [impressions, clicks] } }
function mockGsc(windows) {
  queryPageTotals.mockImplementation(async (_property, { startDate }) => {
    const name = Object.keys(W).find(k => W[k].startDate === startDate);
    return Object.entries(windows[name] ?? {}).map(([u, [impressions, clicks = 0]]) => ({ url: u, impressions, clicks, position: 5 }));
  });
}
// Controls at the target's level, all moving a little (ratio 1.0 to 1.1).
const controlsAt = (level, stage) => Object.fromEntries(CONTROLS.map((s, i) => [url(s), [stage === 'baseline' ? level : level + i * 8]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-measure-'));
  warnings = [];
  queryPageTotals.mockReset();
  mkdirSync(join(dir, 'content/de'), { recursive: true });
  mkdirSync(join(dir, 'content/en'), { recursive: true });
  for (const slug of ['target', 'other', 'fresh', ...CONTROLS]) writeFileSync(join(dir, `content/de/${slug}.md`), '---\n---\n');
  writeFileSync(join(dir, 'content/en/fresh-en.md'), '---\n---\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('measure-step: rewrites', () => {
  it('computes a due reading against the controls, stores baseline and reading, and reports counts', async () => {
    seed(entry());
    mockGsc({
      baseline: { [url('target')]: [1000], ...controlsAt(1000, 'baseline') },
      d28: { [url('target')]: [3000], ...controlsAt(1000, 'after') },
      d56: { [url('target')]: [1050], ...controlsAt(1000, 'after') },
    });

    const report = await run();

    const [saved] = loadChanges(dir).entries;
    expect(saved.baseline).toMatchObject({ impressions: 1000, window: W.baseline });
    expect(saved.readings.d28).toMatchObject({ verdict: 'positive', controls: 14, impressions: 3000, window: W.d28, measured_at: TODAY });
    expect(saved.readings.d56.verdict).toBe('neutral');
    expect(report).toEqual({
      entries: 1, due: 2, measured: 2,
      verdicts: { positive: 1, neutral: 1, negative: 0, insufficient_data: 0 },
      insufficient_by_reason: { volume: 0, control: 0, dispersion: 0, overlap: 0, missing: 0, unmapped: 0 },
      revert_candidates: [],
      changed: [
        { slug: 'target', kind: 'rewrite', reading: 'd28', verdict: 'positive' },
        { slug: 'target', kind: 'rewrite', reading: 'd56', verdict: 'neutral' },
      ],
    });
    expect(queryPageTotals).toHaveBeenCalledWith('sc-domain:a.de', expect.objectContaining({ pageFilter: 'https://a.de' }));
  });

  it('leaves a reading that is not due empty and asks GSC for nothing', async () => {
    seed(entry());

    const report = await run({ today: '2026-09-07' });

    expect(queryPageTotals).not.toHaveBeenCalled();
    expect(loadChanges(dir).entries[0].readings).toEqual({ d28: null, d56: null });
    expect(report).toMatchObject({ due: 0, measured: 0, changed: [] });
  });

  it('flags a revert candidate after two negative readings and warns once', async () => {
    seed(entry({ baseline: { window: W.baseline, clicks: 0, impressions: 1000, ctr: 0, position: 5 }, readings: { d28: { verdict: 'negative', effect: 0.5 }, d56: null } }));
    mockGsc({
      baseline: { [url('target')]: [1000], ...controlsAt(1000, 'baseline') },
      d56: { [url('target')]: [120], ...controlsAt(1000, 'after') },
    });

    const report = await run();

    expect(loadChanges(dir).entries[0]).toMatchObject({ revert_candidate: true, readings: { d56: { verdict: 'negative' } } });
    expect(report.revert_candidates).toEqual(['target']);
    expect(warnings.filter(w => w.includes('Revert candidate: target'))).toHaveLength(1);

    warnings.length = 0;
    await run();
    expect(warnings).toEqual([]);
  });

  it('reports a target without any row in the reading window as missing, not as zero', async () => {
    seed(entry());
    mockGsc({
      baseline: { [url('target')]: [1000], ...controlsAt(1000, 'baseline') },
      d28: { ...controlsAt(1000, 'after') },
    });

    const report = await run({ today: '2026-09-15' });

    expect(loadChanges(dir).entries[0].readings.d28).toMatchObject({ verdict: 'insufficient_data', reason: 'missing' });
    expect(report.insufficient_by_reason.missing).toBe(1);
  });

  it('treats a row with small numbers as a real value', async () => {
    seed(entry());
    mockGsc({
      baseline: { [url('target')]: [1000], ...controlsAt(1000, 'baseline') },
      d28: { [url('target')]: [5], ...controlsAt(1000, 'after') },
    });

    await run({ today: '2026-09-15' });

    expect(loadChanges(dir).entries[0].readings.d28).toMatchObject({ verdict: 'negative', impressions: 5 });
  });

  it('marks a target URL that maps to no landing page as unmapped once and never measures it', async () => {
    seed(entry({ urls: [url('gone-page')] }));

    const report = await run();
    const again = await run();

    expect(queryPageTotals).not.toHaveBeenCalled();
    const [saved] = loadChanges(dir).entries;
    expect(saved).toMatchObject({ unmapped: true, readings: { d28: null, d56: null } });
    expect(report).toMatchObject({ due: 0, measured: 0 });
    expect(report.insufficient_by_reason.unmapped).toBe(1);
    expect(warnings.filter(w => w.includes('maps to no landing page'))).toHaveLength(1);
    expect(again.insufficient_by_reason.unmapped).toBe(1);
  });

  it('does not compute d56 in the same run when d28 failed', async () => {
    seed(entry());
    queryPageTotals.mockImplementation(async (_property, { startDate }) => {
      if (startDate === W.d28.startDate) throw new Error('quota');
      return [{ url: url('target'), impressions: 1000, clicks: 0, position: 5 }];
    });

    const report = await run();

    expect(report).toMatchObject({ due: 1, measured: 0 });
    expect(loadChanges(dir).entries[0].readings).toEqual({ d28: null, d56: null });
    expect(queryPageTotals.mock.calls.some(([, w]) => w.startDate === W.d56.startDate)).toBe(false);
  });

  it('marks two rewrites of the same page as overlap without asking GSC', async () => {
    seed(entry(), entry({ id: 'pr2', urls: [url('target')], pr_url: 'pr2', merged_at: '2026-08-10' }));

    const report = await run({ today: '2026-09-20' });

    expect(queryPageTotals).not.toHaveBeenCalled();
    const entries = loadChanges(dir).entries;
    expect(entries[0].readings.d28).toMatchObject({ verdict: 'insufficient_data', reason: 'overlap' });
    expect(entries[1].readings.d28).toMatchObject({ verdict: 'insufficient_data', reason: 'overlap' });
    expect(report.insufficient_by_reason.overlap).toBe(2);
  });

  it('reports control as the reason when fewer than 12 pages can serve as control', async () => {
    seed(entry());
    mockGsc({
      baseline: { [url('target')]: [1000], ...Object.fromEntries(CONTROLS.slice(0, 5).map(s => [url(s), [1000]])) },
      d28: { [url('target')]: [1500] },
    });

    const report = await run({ today: '2026-09-15' });

    expect(report.insufficient_by_reason.control).toBe(1);
  });
});

describe('measure-step: new pages', () => {
  it('stores absolute values summed over all urls, without a verdict', async () => {
    seed(entry({ id: 'pr3', kind: 'new', slug: 'fresh', urls: [url('fresh'), url('en/fresh-en')], pr_url: 'pr3' }));
    mockGsc({ d28: { [url('fresh')]: [100, 10], [url('en/fresh-en')]: [300, 20], [url('control-0')]: [5000] } });

    const report = await run({ today: '2026-09-15' });

    const reading = loadChanges(dir).entries[0].readings.d28;
    expect(reading).toMatchObject({ impressions: 400, clicks: 30, ctr: 0.075, position: 5 });
    expect(reading.verdict).toBeUndefined();
    expect(loadChanges(dir).entries[0].baseline).toBeNull();
    expect(report.changed).toEqual([{ slug: 'fresh', kind: 'new', reading: 'd28', verdict: null }]);
    expect(queryPageTotals).toHaveBeenCalledTimes(1);
  });
});

describe('measure-step: failures and dry run', () => {
  it('warns and stores nothing when GSC fails, and the run goes on', async () => {
    seed(entry());
    queryPageTotals.mockRejectedValue(new Error('quota'));
    const before = readFileSync(join(dir, CHANGES_FILE), 'utf8');

    const report = await run();

    expect(warnings.some(w => w.includes('quota'))).toBe(true);
    expect(report).toMatchObject({ due: 1, measured: 0, changed: [] });
    expect(readFileSync(join(dir, CHANGES_FILE), 'utf8')).toBe(before);
  });

  it('treats an answer without any landing page impressions as an error', async () => {
    seed(entry());
    mockGsc({ baseline: { 'https://a.de/blog/post': [900], 'https://a.de/': [500] }, d28: {}, d56: {} });
    const before = readFileSync(join(dir, CHANGES_FILE), 'utf8');

    const report = await run();

    expect(warnings.some(w => w.includes('no landing page impressions'))).toBe(true);
    expect(report.measured).toBe(0);
    expect(readFileSync(join(dir, CHANGES_FILE), 'utf8')).toBe(before);
  });

  it('computes and reports on a dry run but writes nothing', async () => {
    seed(entry({ id: 'pr3', kind: 'new', slug: 'fresh', urls: [url('fresh')], pr_url: 'pr3' }));
    mockGsc({ d28: { [url('fresh')]: [100, 10] }, d56: { [url('fresh')]: [100, 10] } });
    const before = readFileSync(join(dir, CHANGES_FILE), 'utf8');

    const report = await run({ dryRun: true });

    expect(report.measured).toBe(2);
    expect(readFileSync(join(dir, CHANGES_FILE), 'utf8')).toBe(before);
  });

  it('measures an overlay against overlay controls only, never against landing pages', async () => {
    const config = { ...CONFIG, overlays: { products: 'content/seo/products' } };
    const shop = (slug) => `https://a.de/shop/${slug}`;
    const products = Array.from({ length: 14 }, (_, i) => `p-${i}`);
    const level = (stage) => Object.fromEntries(products.map((s, i) => [shop(s), [stage === 'baseline' ? 1000 : 1000 + i * 8]]));
    seed(entry({ slug: 'product:target', urls: [shop('target')] }));
    mockGsc({
      baseline: { [shop('target')]: [1000], ...level('baseline'), ...controlsAt(1000, 'baseline') },
      d28: { [shop('target')]: [3000], ...level('after'), ...controlsAt(1000, 'after') },
      d56: { [shop('target')]: [1050], ...level('after'), ...controlsAt(1000, 'after') },
    });

    await run({ config });

    const [saved] = loadChanges(dir).entries;
    expect(saved.readings.d28).toMatchObject({ verdict: 'positive', controls: 14 });
  });

  it('measures a landing page rewrite without shop pages as controls', async () => {
    const config = { ...CONFIG, overlays: { products: 'content/seo/products' } };
    const shop = (slug) => `https://a.de/shop/${slug}`;
    const noise = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [shop(`p-${i}`), [1000]]));
    seed(entry());
    mockGsc({
      baseline: { [url('target')]: [1000], ...noise, ...controlsAt(1000, 'baseline') },
      d28: { [url('target')]: [3000], ...noise, ...controlsAt(1000, 'after') },
      d56: { [url('target')]: [1050], ...noise, ...controlsAt(1000, 'after') },
    });

    await run({ config });

    expect(loadChanges(dir).entries[0].readings.d28).toMatchObject({ verdict: 'positive', controls: 14 });
  });
});

describe('measure-step: rybbit', () => {
  const RYBBIT = { enabled: true, url: 'https://t.example.org', site_id: 3, macro_goal: 'Signup', micro_goals: [] };
  const goals = [{ goalId: 1, name: 'Signup', total_conversions: 4, total_sessions: 50 }];
  let fetchMock, status;

  const runWith = (over = {}) => run({ config: { ...CONFIG, rybbit: RYBBIT }, ...over });
  const baseOf = (reading) => Object.fromEntries(Object.entries(reading).filter(([k]) => k !== 'rybbit'));
  const readingsOf = () => loadChanges(dir).entries.map(e => e.readings.d28);

  beforeEach(() => {
    process.env.RYBBIT_API_KEY = 'k';
    resetRybbitGuard();
    status = 200;
    fetchMock = vi.fn(async (rawUrl) => {
      const u = new URL(rawUrl);
      const body = u.pathname.endsWith('/goals')
        ? { data: goals }
        : { data: { data: u.searchParams.has('filters') ? [] : [{ value: '/target', count: 12, bounce_rate: 50, time_on_page_seconds: 30 }, { value: '/fresh', count: 12, bounce_rate: 50, time_on_page_seconds: 30 }] } };
      return { status, ok: status < 300, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    delete process.env.RYBBIT_API_KEY;
    vi.unstubAllGlobals();
  });

  const scenarios = {
    'a rewrite with a verdict': () => {
      seed(entry());
      mockGsc({ baseline: { [url('target')]: [1000], ...controlsAt(1000, 'baseline') }, d28: { [url('target')]: [3000], ...controlsAt(1000, 'after') } });
      return '2026-09-15';
    },
    'a new page': () => {
      seed(entry({ id: 'pr3', kind: 'new', slug: 'fresh', urls: [url('fresh')], pr_url: 'pr3' }));
      mockGsc({ d28: { [url('fresh')]: [10] } });
      return '2026-09-15';
    },
    'an overlap': () => {
      seed(entry(), entry({ id: 'pr2', urls: [url('target')], pr_url: 'pr2', merged_at: '2026-08-10' }));
      return '2026-09-20';
    },
    'a missing target': () => {
      seed(entry());
      mockGsc({ baseline: { [url('target')]: [1000], ...controlsAt(1000, 'baseline') }, d28: { ...controlsAt(1000, 'after') } });
      return '2026-09-15';
    },
  };

  it.each(Object.keys(scenarios))('attaches the Rybbit values to %s', async (name) => {
    const today = scenarios[name]();

    await runWith({ today });

    const [first] = readingsOf();
    expect(first.rybbit).toMatchObject({ entries: 12, macro: 4, micro: 0 });
  });

  it('adds no field without rybbit.enabled', async () => {
    const today = scenarios['a rewrite with a verdict']();

    await run({ today });

    expect(readingsOf()[0]).not.toHaveProperty('rybbit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores null during an outage, then fills in only the field later and never touches the verdict', async () => {
    const today = scenarios['a rewrite with a verdict']();
    status = 503;
    await runWith({ today });
    const [gap] = readingsOf();
    expect(gap.rybbit).toBeNull();
    expect(gap.verdict).toBe('positive');

    status = 200;
    resetRybbitGuard();
    queryPageTotals.mockClear();
    await runWith({ today });

    const [filled] = readingsOf();
    expect(filled.rybbit).toMatchObject({ entries: 12 });
    expect(baseOf(filled)).toEqual(baseOf(gap));
    expect(queryPageTotals).not.toHaveBeenCalled();
  });

  it('also refills a reading whose macro or micro is null, and leaves the verdict alone', async () => {
    const today = scenarios['a rewrite with a verdict']();
    await runWith({ today });
    const [done] = readingsOf();
    const e = loadChanges(dir);
    e.entries[0].readings.d28.rybbit = { ...done.rybbit, macro: null, micro: null };
    saveChanges(e, dir);
    resetRybbitGuard();

    await runWith({ today });

    const [filled] = readingsOf();
    expect(filled.rybbit).toMatchObject({ entries: 12, macro: 4, micro: 0 });
    expect(baseOf(filled)).toEqual(baseOf(done));
  });

  it('does not retry a gap in the run that created it', async () => {
    const today = scenarios['a rewrite with a verdict']();
    const working = fetchMock.getMockImplementation();
    fetchMock.mockImplementationOnce(async () => ({ status: 503, ok: false, json: async () => ({}) }));
    fetchMock.mockImplementation(working);

    await runWith({ today });

    expect(readingsOf()[0].rybbit).toBeNull();
  });

  it('leaves gaps of readings whose window is older than 90 days', async () => {
    const today = scenarios['a rewrite with a verdict']();
    status = 503;
    await runWith({ today });
    status = 200;
    resetRybbitGuard();
    fetchMock.mockClear();

    await runWith({ today: '2027-03-01' });

    expect(readingsOf()[0].rybbit).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
