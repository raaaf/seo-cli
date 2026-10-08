import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { generatePage } = await import('../src/steps/generate.js');
const { MODELS, GENERATE_MAX_TOKENS } = await import('../src/lib/models.js');
const { makeCatalog } = await import('./helpers/catalog.js');
const { putSignal } = await import('../src/lib/signals/store.js');

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
      model: MODELS.generate, maxTokens: GENERATE_MAX_TOKENS,
    }));
  });

  it('passes validator feedback into the retry prompt', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, config, dir, { errors: ['Body too short: 10 words (min 800)'] });
    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('Body too short: 10 words (min 800)');
  });

  it('requests a batch by default', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, config, dir);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ batch: true }));
  });

  it('requests interactive completion when batch_generation is false', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, { ...config, batch_generation: false }, dir);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ batch: false }));
  });

  it('puts the catalog and the contract rules into the prompt', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    const contractConfig = { ...config, page_contract: { forbid: ['steps'], lowercase: true } };
    await generatePage(keyword, contractConfig, dir, null, { catalog: makeCatalog() });
    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('- sonntag: sonntag');
    expect(prompt).toContain('Forbidden frontmatter fields (never emit them): steps');
    expect(prompt).toContain('only from the product catalog');
  });

  it('adds no contract section without configuration', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, config, dir);
    expect(complete.mock.calls[0][0].prompt).not.toContain('Page contract');
  });
});

describe('generate-page: Bing questions', () => {
  const stored = [
    { query: 'hochzeit planen im sommer', impressions: 9, clicks: 0, position: 5 },
    { query: 'kinderschminken', impressions: 99, clicks: 0, position: 5 },
  ];
  const promptFor = async (cfg, withStore) => {
    complete.mockReset().mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    if (withStore) putSignal('bing', 'queries:https://acme.io/', stored, new Date(), { cwd: dir });
    await generatePage({ ...keyword, serp: { people_also_ask: ['Was kostet eine Hochzeit?'], related_searches: [] } }, cfg, dir);
    return complete.mock.calls[0][0].prompt;
  };

  it('appends matching stored questions to the PAA slot', async () => {
    const prompt = await promptFor({ ...config, bing: { enabled: true } }, true);
    expect(prompt).toContain('Was kostet eine Hochzeit?');
    expect(prompt).toContain('hochzeit planen im sommer');
    expect(prompt).not.toContain('kinderschminken');
  });

  it('renders the prompt byte for byte as without Bing when bing.enabled is off', async () => {
    const plain = await promptFor(config, false);
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'seo-gen-'));
    expect(await promptFor({ ...config, bing: { enabled: false } }, true)).toBe(plain);
  });
});

