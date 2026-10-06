import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const createBranchAndCommit = vi.fn();
const openPR = vi.fn();
const deleteBranch = vi.fn();
vi.mock('../src/lib/github.js', () => ({
  createBranchAndCommit: (...a) => createBranchAndCommit(...a),
  openPR: (...a) => openPR(...a),
  deleteBranch: (...a) => deleteBranch(...a),
}));

const { createPRs } = await import('../src/steps/pr.js');

beforeEach(() => {
  createBranchAndCommit.mockResolvedValue('seo/new/hochzeit-planen');
  openPR.mockResolvedValue('https://github.com/o/r/pull/42');
  deleteBranch.mockResolvedValue();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const kwData = (...names) => ({ keywords: names.map(keyword => ({ keyword, status: 'pr_opened', score: 9 })) });

const page = (over = {}) => ({
  keyword: 'hochzeit planen', slug: 'hochzeit-planen', score: 9, type: 'guide',
  locale: 'de', filePath: 'resources/landing/de/hochzeit-planen.md',
  markdown: '---\nslug: hochzeit-planen\nmeta_title: T\n---\nbody', ...over,
});

describe('pr-create', () => {
  const config = { repo: 'o/r', locale: 'de', locales: ['de'] };

  it('opens one PR on seo/new/<slug> with the page only, no state files', async () => {
    const data = kwData('hochzeit planen');
    const { prs } = await createPRs({ generatedPages: [page()], keywordsData: data, config });

    expect(prs).toEqual([{ url: 'https://github.com/o/r/pull/42', keyword: 'hochzeit planen', slug: 'hochzeit-planen' }]);
    const arg = createBranchAndCommit.mock.calls[0][0];
    expect(arg.branch).toBe('seo/new/hochzeit-planen');
    expect(arg.files.map(f => f.path)).toEqual(['resources/landing/de/hochzeit-planen.md']);
    expect(openPR).toHaveBeenCalledWith(expect.objectContaining({ branch: 'seo/new/hochzeit-planen' }));
    expect(openPR.mock.calls[0][0].body).toContain('SEO check');
  });

  it('stores the PR url and the sitemap slugs on the keyword entry', async () => {
    const data = kwData('hochzeit planen');
    await createPRs({ generatedPages: [page()], keywordsData: data, config });

    expect(data.keywords[0]).toMatchObject({ status: 'pr_opened', pr_url: 'https://github.com/o/r/pull/42', sitemap_slugs: ['/hochzeit-planen'] });
  });

  it('opens a separate PR per keyword, each with only its own files', async () => {
    openPR.mockResolvedValueOnce('https://github.com/o/r/pull/1').mockResolvedValueOnce('https://github.com/o/r/pull/2');
    const pages = [page(), page({ keyword: 'brautkleid', slug: 'brautkleid', filePath: 'resources/landing/de/brautkleid.md' })];

    const { prs } = await createPRs({ generatedPages: pages, keywordsData: kwData('hochzeit planen', 'brautkleid'), config });

    expect(prs).toHaveLength(2);
    expect(createBranchAndCommit.mock.calls.map(c => c[0].branch)).toEqual(['seo/new/hochzeit-planen', 'seo/new/brautkleid']);
    expect(createBranchAndCommit.mock.calls[1][0].files.map(f => f.path)).toEqual(['resources/landing/de/brautkleid.md']);
  });

  it('ships the counterpart in the keyword PR and queues its bare /{slug} sitemap path', async () => {
    const cfg = { ...config, counterpart_locale: 'en' };
    const data = kwData('hochzeit planen');
    const pages = [page(), page({ locale: 'en', slug: 'wedding-planning', filePath: 'resources/landing/en/wedding-planning.md' })];
    await createPRs({ generatedPages: pages, keywordsData: data, config: cfg });

    expect(createBranchAndCommit).toHaveBeenCalledTimes(1);
    const { files, branch } = createBranchAndCommit.mock.calls[0][0];
    expect(branch).toBe('seo/new/hochzeit-planen');
    expect(files.map(f => f.path)).toEqual(['resources/landing/de/hochzeit-planen.md', 'resources/landing/en/wedding-planning.md']);
    expect(files[1].content).not.toContain('hreflang:'); // not hreflang mode: locales has one entry
    expect(data.keywords[0].sitemap_slugs).toEqual(['/hochzeit-planen', '/wedding-planning']);
  });

  it('prefixes the counterpart sitemap entry with counterpart_url_prefix when set', async () => {
    const cfg = { ...config, counterpart_locale: 'en', counterpart_url_prefix: '/en' };
    const data = kwData('hochzeit planen');
    const pages = [page(), page({ locale: 'en', slug: 'website-maintenance', filePath: 'resources/landing/en/website-maintenance.md' })];
    await createPRs({ generatedPages: pages, keywordsData: data, config: cfg });

    expect(data.keywords[0].sitemap_slugs).toContain('/en/website-maintenance');
  });

  it('injects hreflang over all locales of a slug before the pages are split per keyword', async () => {
    const cfg = { repo: 'o/r', locale: 'de', locales: ['de', 'en'] };
    const pages = [page(), page({ locale: 'en', filePath: 'resources/landing/en/hochzeit-planen.md' })];
    await createPRs({ generatedPages: pages, keywordsData: kwData('hochzeit planen'), config: cfg });

    const { files } = createBranchAndCommit.mock.calls[0][0];
    const dePage = files.find(f => f.path === 'resources/landing/de/hochzeit-planen.md');
    expect(dePage.content).toContain('hreflang:');
    expect(dePage.content).toContain('en: /en/hochzeit-planen');
    expect(dePage.content).toContain('de: /hochzeit-planen');
  });

  it('skips a keyword whose branch exists, sets it back to proposed and keeps going', async () => {
    createBranchAndCommit.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'BRANCH_EXISTS' }));
    const data = kwData('hochzeit planen', 'brautkleid');
    const pages = [page(), page({ keyword: 'brautkleid', slug: 'brautkleid', filePath: 'resources/landing/de/brautkleid.md' })];

    const { prs, warnings, errors } = await createPRs({ generatedPages: pages, keywordsData: data, config });

    expect(prs.map(p => p.keyword)).toEqual(['brautkleid']);
    expect(warnings[0]).toMatch(/seo\/new\/hochzeit-planen already exists/);
    expect(deleteBranch).not.toHaveBeenCalled(); // the existing branch belongs to the open PR
    expect(errors).toEqual([]);
    expect(data.keywords[0]).toMatchObject({ status: 'proposed' });
    expect(data.keywords[0].pr_url).toBeUndefined();
    expect(data.keywords[1].status).toBe('pr_opened');
  });

  it('reports any other failure as an error and sets the keyword back to proposed', async () => {
    openPR.mockRejectedValue(new Error('GitHub 500'));
    const data = kwData('hochzeit planen');

    const { prs, errors } = await createPRs({ generatedPages: [page()], keywordsData: data, config });

    expect(prs).toEqual([]);
    expect(errors[0]).toMatch(/GitHub 500/);
    expect(data.keywords[0].status).toBe('proposed');
    expect(deleteBranch).toHaveBeenCalledWith({ repo: 'o/r', branch: 'seo/new/hochzeit-planen' });
  });
});
