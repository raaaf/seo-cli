import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { pickAssessedPage, slugForUrl, counterpartPairs, annotateFollowups, assessmentDiagnosis } = await import('../src/lib/assessed-rewrite.js');

const BASE = 'https://events.example.de';
const config = (extra = {}) => ({ locale: 'de', landing_path: 'content/landing/de/', counterpart_locale: 'en', base_url: BASE, ...extra });
const assessment = (extra = {}) => ({ assessed_at: '2026-11-05', likely_causes: ['Unbelegte Prozentzahlen'], actions: [{ action: 'Zahlen streichen', why: 'Vertrauen' }], ...extra });
const alert = (slug, extra = {}) => ({
  id: `deindexed:${BASE}/${slug}`, kind: 'deindexed',
  diagnosis: { cause: 'clean', urls: [{ url: `${BASE}/${slug}`, findings: [] }] },
  assessment: assessment(), ...extra,
});

describe('assessed rewrite', () => {
  let dir;
  const page = (locale, slug, alternate) => {
    mkdirSync(join(dir, `content/landing/${locale}`), { recursive: true });
    writeFileSync(join(dir, `content/landing/${locale}`, `${slug}.md`), `---\nslug: ${slug}\n${alternate ? `alternate: ${alternate}\n` : ''}---\nbody`);
  };
  const today = new Date('2026-11-12T12:00:00Z');
  const pick = (open, improvements = { entries: [] }, cfg = config()) => pickAssessedPage({ config: cfg, cwd: dir, today, improvements, alerts: { open } });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seo-assessed-'));
    page('de', 'teamevent-organisieren', 'team-event');
    page('en', 'team-event', 'teamevent-organisieren');
    page('de', 'silvesterparty-planen', 'new-years-party');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists default-locale pages with their counterpart', () => {
    expect(counterpartPairs(config(), dir)).toEqual([
      { slug: 'silvesterparty-planen', counterpart: 'new-years-party' },
      { slug: 'teamevent-organisieren', counterpart: 'team-event' },
    ]);
  });

  it('maps a counterpart URL to its default-locale page', () => {
    const pairs = counterpartPairs(config(), dir);
    expect(slugForUrl(`${BASE}/team-event/`, config(), pairs)).toBe('teamevent-organisieren');
    expect(slugForUrl(`${BASE}/teamevent-organisieren`, config(), pairs)).toBe('teamevent-organisieren');
    expect(slugForUrl(`${BASE}/en/new-years-party`, config({ counterpart_url_prefix: '/en' }), pairs)).toBe('silvesterparty-planen');
    expect(slugForUrl(`${BASE}/gibt-es-nicht`, config(), pairs)).toBeNull();
    expect(slugForUrl('https://other.example/team-event', config(), pairs)).toBeNull();
  });

  it('picks the oldest assessed, technically clean deindexed page', () => {
    const later = alert('silvesterparty-planen', { assessment: assessment({ assessed_at: '2026-11-06' }) });
    expect(pick([later, alert('teamevent-organisieren')])).toMatchObject({ slug: 'teamevent-organisieren', alert_id: `deindexed:${BASE}/teamevent-organisieren` });
  });

  it('skips alerts that are technical, unassessed, owned by someone else or site-wide', () => {
    expect(pick([alert('teamevent-organisieren', { diagnosis: { cause: 'technical', urls: [{ url: `${BASE}/teamevent-organisieren`, findings: [] }] } })])).toBeNull();
    expect(pick([alert('teamevent-organisieren', { assessment: undefined })])).toBeNull();
    expect(pick([alert('teamevent-organisieren', { assessment: assessment({ actions: [] }) })])).toBeNull();
    expect(pick([alert('teamevent-organisieren', { assessment: assessment({ content_owner: 'Alex' }) })])).toBeNull();
    expect(pick([{ id: 'site_not_indexed', kind: 'site_not_indexed', diagnosis: { cause: 'clean', urls: [] }, assessment: assessment() }])).toBeNull();
  });

  it('skips a page in the cooldown, excluded, or rewritten since the assessment', () => {
    expect(pick([alert('teamevent-organisieren')], { entries: [{ slug: 'teamevent-organisieren', date: '2026-10-01' }] })).toBeNull();
    expect(pick([alert('teamevent-organisieren')], { entries: [] }, config({ exclude_slugs: ['teamevent-organisieren'] }))).toBeNull();
    // Outside the cooldown, but rewritten after the assessment.
    const old = alert('teamevent-organisieren', { assessment: assessment({ assessed_at: '2026-08-01' }) });
    expect(pick([old], { entries: [{ slug: 'teamevent-organisieren', date: '2026-08-10' }] })).toBeNull();
    // A failed attempt is no rewrite, but its cooldown still holds the page.
    expect(pick([old], { entries: [{ slug: 'teamevent-organisieren', date: '2026-08-10', failed: true }] })).toMatchObject({ slug: 'teamevent-organisieren' });
  });

  it('puts causes and actions into the rewrite diagnosis', () => {
    const text = assessmentDiagnosis(assessment());
    expect(text).toContain('- Unbelegte Prozentzahlen');
    expect(text).toContain('- Zahlen streichen (Vertrauen)');
    expect(text).toMatch(/not part of this rewrite/);
  });

  it('annotates what happens with each assessment', () => {
    const list = [
      { alert_id: `deindexed:${BASE}/teamevent-organisieren` },
      { alert_id: `deindexed:${BASE}/silvesterparty-planen` },
      { alert_id: 'site_not_indexed' },
      { alert_id: `deindexed:${BASE}/shop/x`, content_owner: 'Alex' },
      { alert_id: `deindexed:${BASE}/gibt-es-nicht` },
    ];
    annotateFollowups({
      assessments: list, config: config(), cwd: dir, today: '2026-11-05',
      prs: [{ kind: 'improve', slug: 'teamevent-organisieren', url: 'https://github.com/x/pull/1' }],
      improvements: { entries: [{ slug: 'silvesterparty-planen', date: '2026-11-05' }] },
    });
    expect(list.map(s => s.followup)).toEqual([
      { status: 'rewritten', slug: 'teamevent-organisieren', pr_url: 'https://github.com/x/pull/1' },
      { status: 'scheduled', slug: 'silvesterparty-planen', not_before: '2026-12-31' },
      { status: 'site' },
      { status: 'owner' },
      { status: 'unmapped' },
    ]);
  });
});
