import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { generatePage } = await import('../src/steps/generate.js');

let dir;
const config = {
  base_url: 'https://acme.io/', locale: 'de', locales: ['de'],
  site_name: 'Acme', landing_path: 'resources/landing/de/',
};
const keyword = { keyword: 'hochzeit planen', target_slug: 'hochzeit-planen', type: 'guide' };

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-gen-')); complete.mockReset(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('generate-page', () => {
  it('rejects an invalid target_slug before calling the model', async () => {
    await expect(generatePage({ keyword: 'x', target_slug: '../evil' }, config, dir))
      .rejects.toThrow(/Invalid target_slug/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('strips a wrapping code fence and replaces URL/name placeholders', async () => {
    complete.mockResolvedValue(
      '```markdown\n---\nslug: hochzeit-planen\n---\nCanonical: CANONICAL_URL\nBase: BASE_URL\nSite: SITE_NAME\n```'
    );
    const md = await generatePage(keyword, config, dir);

    expect(md.startsWith('---')).toBe(true); // fence removed, frontmatter on line 1
    expect(md).toContain('Canonical: https://acme.io/hochzeit-planen');
    expect(md).toContain('Base: https://acme.io');
    expect(md).toContain('Site: Acme');
    expect(md).not.toContain('CANONICAL_URL');
  });

  it('calls Opus with the larger token budget', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, config, dir);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-opus-4-7', maxTokens: 8000,
    }));
  });

  it('passes validator feedback into the retry prompt', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, config, dir, { errors: ['Body too short: 10 words (min 800)'] });
    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('Body too short: 10 words (min 800)');
  });
});
