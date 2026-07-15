import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const createBranchAndCommit = vi.fn();
const openPR = vi.fn();
vi.mock('../src/lib/github.js', () => ({
  createBranchAndCommit: (...a) => createBranchAndCommit(...a),
  openPR: (...a) => openPR(...a),
}));

const { createPR } = await import('../src/steps/pr.js');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-pr-'));
  createBranchAndCommit.mockResolvedValue('seo/2026-W26');
  openPR.mockResolvedValue('https://github.com/o/r/pull/42');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

const page = (over = {}) => ({
  keyword: 'hochzeit planen', slug: 'hochzeit-planen', score: 9, type: 'guide',
  locale: 'de', filePath: 'resources/landing/de/hochzeit-planen.md',
  markdown: '---\nslug: hochzeit-planen\nmeta_title: T\n---\nbody', ...over,
});

describe('pr-create', () => {
  it('commits the page plus keywords/sitemap state and opens a PR', async () => {
    const config = { repo: 'o/r', locale: 'de', locales: ['de'] };
    const url = await createPR({ generatedPages: [page()], keywordsJsonContent: { keywords: [] }, config, cwd: dir });

    expect(url).toBe('https://github.com/o/r/pull/42');
    const { files } = createBranchAndCommit.mock.calls[0][0];
    const paths = files.map(f => f.path);
    expect(paths).toContain('resources/landing/de/hochzeit-planen.md');
    expect(paths).toContain('seo/keywords.json');
    expect(paths).toContain('seo/sitemap-pending.json');

    const sitemap = JSON.parse(files.find(f => f.path === 'seo/sitemap-pending.json').content);
    expect(sitemap.slugs).toContain('/hochzeit-planen');

    const prBody = openPR.mock.calls[0][0].body;
    expect(prBody).toContain('hochzeit planen');
    expect(prBody).toContain('SEO check');
  });

  it('queues the bare /{slug} sitemap path for a counterpart page (shared URL space, no locale prefix)', async () => {
    const config = { repo: 'o/r', locale: 'de', locales: ['de'], counterpart_locale: 'en' };
    const pages = [
      page(),
      page({ locale: 'en', slug: 'wedding-planning', filePath: 'resources/landing/en/wedding-planning.md' }),
    ];
    await createPR({ generatedPages: pages, keywordsJsonContent: { keywords: [] }, config, cwd: dir });

    const { files } = createBranchAndCommit.mock.calls[0][0];
    const sitemap = JSON.parse(files.find(f => f.path === 'seo/sitemap-pending.json').content);
    expect(sitemap.slugs).toContain('/hochzeit-planen');
    expect(sitemap.slugs).toContain('/wedding-planning');

    // Not hreflang mode: config.locales still has only one entry.
    const enPage = files.find(f => f.path === 'resources/landing/en/wedding-planning.md');
    expect(enPage.content).not.toContain('hreflang:');
  });

  it('injects hreflang frontmatter for multi-locale pages', async () => {
    const config = { repo: 'o/r', locale: 'de', locales: ['de', 'en'] };
    const pages = [
      page(),
      page({ locale: 'en', filePath: 'resources/landing/en/hochzeit-planen.md' }),
    ];
    await createPR({ generatedPages: pages, keywordsJsonContent: { keywords: [] }, config, cwd: dir });

    const { files } = createBranchAndCommit.mock.calls[0][0];
    const dePage = files.find(f => f.path === 'resources/landing/de/hochzeit-planen.md');
    expect(dePage.content).toContain('hreflang:');
    expect(dePage.content).toContain('en: /en/hochzeit-planen');
    expect(dePage.content).toContain('de: /hochzeit-planen');
  });
});
