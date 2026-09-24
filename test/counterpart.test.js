import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { generateCounterpart, linkAlternates, rewriteCounterpartLinks } = await import('../src/steps/counterpart.js');
const { MODELS, GENERATE_MAX_TOKENS } = await import('../src/lib/models.js');

let dir;
const config = {
  base_url: 'https://acme.io/', locale: 'de', locales: ['de'],
  site_name: 'Acme', landing_path: 'resources/landing/de/', counterpart_locale: 'en',
};
const keyword = { keyword: 'firmenfeier planen', target_slug: 'firmenfeier-planen', type: 'guide' };

const sourceMarkdown = `---
slug: firmenfeier-planen
meta_title: Firmenfeier planen fuer Teams
---
Ein Text ueber die Planung einer Firmenfeier.`;

function writeLanding(relDir, name, content = '# x') {
  const full = join(dir, relDir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, name), content, 'utf8');
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-cp-')); complete.mockReset(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('generate-counterpart', () => {
  it('returns the markdown and chosen slug on a clean first attempt', async () => {
    complete.mockResolvedValue('---\nslug: company-event-planning\nmeta_title: Company Event Planning\n---\nBody.');
    const { markdown, slug } = await generateCounterpart(sourceMarkdown, keyword, config, dir);

    expect(slug).toBe('company-event-planning');
    expect(markdown).toContain('slug: company-event-planning');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: MODELS.generate, maxTokens: GENERATE_MAX_TOKENS }));
  });

  it('retries once when the chosen slug collides with an existing page, then succeeds', async () => {
    writeLanding('resources/landing/en', 'team-building.md');
    complete
      .mockResolvedValueOnce('---\nslug: team-building\n---\nBody.')
      .mockResolvedValueOnce('---\nslug: club-events\n---\nBody.');

    const { slug } = await generateCounterpart(sourceMarkdown, keyword, config, dir);

    expect(slug).toBe('club-events');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0].prompt).toContain('Slug rejected');
    expect(complete.mock.calls[1][0].prompt).toContain('team-building');
  });

  it('throws when the retried slug still collides', async () => {
    writeLanding('resources/landing/en', 'team-building.md');
    complete.mockResolvedValue('---\nslug: team-building\n---\nBody.');

    await expect(generateCounterpart(sourceMarkdown, keyword, config, dir)).rejects.toThrow(/collides/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed slug as a rejection, then throws if it recurs', async () => {
    complete.mockResolvedValue('---\nslug: Not A Valid Slug\n---\nBody.');

    await expect(generateCounterpart(sourceMarkdown, keyword, config, dir)).rejects.toThrow(/invalid slug/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('checks collisions against slugs generated earlier in the same run', async () => {
    complete.mockResolvedValue('---\nslug: club-events\n---\nBody.');

    await expect(generateCounterpart(sourceMarkdown, keyword, config, dir, { extraExistingSlugs: ['club-events'] }))
      .rejects.toThrow(/collides/);
  });

  it('replaces BASE_URL, SITE_NAME, and CANONICAL_URL with the bare (locale-prefix-free) counterpart URL', async () => {
    complete.mockResolvedValue('---\nslug: club-events\n---\nCanonical: CANONICAL_URL\nBase: BASE_URL\nSite: SITE_NAME');
    const { markdown } = await generateCounterpart(sourceMarkdown, keyword, config, dir);

    expect(markdown).toContain('Canonical: https://acme.io/club-events');
    expect(markdown).toContain('Base: https://acme.io');
    expect(markdown).toContain('Site: Acme');
  });

  it('sends separate labeled slug lists per locale, so related_pages cannot leak a source-locale slug', async () => {
    writeLanding('resources/landing/de', 'hochzeit-planen.md');
    writeLanding('resources/landing/de', 'geburtstag-feiern.md');
    writeLanding('resources/landing/en', 'wedding-planning.md');
    complete.mockResolvedValue('---\nslug: club-events\n---\nBody.');

    await generateCounterpart(sourceMarkdown, keyword, config, dir);

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('Slugs already used in de');
    expect(prompt).toContain('Slugs already used in en');

    // The target-locale (en) list is the one substituted after "related_pages):" —
    // it must contain only the en slug, never a de slug.
    const targetListLine = prompt.split('\n\n').find(p => p.includes('ONLY slugs'));
    expect(targetListLine).toContain('wedding-planning');
    expect(targetListLine).not.toContain('hochzeit-planen');
    expect(targetListLine).not.toContain('geburtstag-feiern');

    const sourceListLine = prompt.split('\n\n').find(p => p.includes('do not reuse, do not reference'));
    expect(sourceListLine).toContain('hochzeit-planen');
    expect(sourceListLine).toContain('geburtstag-feiern');
    expect(sourceListLine).not.toContain('wedding-planning');
  });

  it('checks slug collisions against the union of both locales, not just the target', async () => {
    writeLanding('resources/landing/de', 'club-events.md');
    complete.mockResolvedValue('---\nslug: club-events\n---\nBody.');

    await expect(generateCounterpart(sourceMarkdown, keyword, config, dir)).rejects.toThrow(/collides/);
  });

  it('leaves CANONICAL_URL byte-identical to today when counterpart_url_prefix is unset', async () => {
    complete.mockResolvedValue('---\nslug: club-events\n---\nCanonical: CANONICAL_URL');
    const { markdown } = await generateCounterpart(sourceMarkdown, keyword, config, dir);

    expect(markdown).toContain('Canonical: https://acme.io/club-events');
  });

  it('includes counterpart_url_prefix in CANONICAL_URL when set', async () => {
    writeLanding('resources/landing/en', 'web-development.md');
    const prefixedConfig = { ...config, counterpart_url_prefix: '/en' };
    complete.mockResolvedValue('---\nslug: club-events\n---\nCanonical: CANONICAL_URL');

    const { markdown } = await generateCounterpart(sourceMarkdown, keyword, prefixedConfig, dir);

    expect(markdown).toContain('Canonical: https://acme.io/en/club-events');
  });

  it('rewrites links to other target-locale slugs with counterpart_url_prefix', async () => {
    writeLanding('resources/landing/en', 'web-development.md');
    const prefixedConfig = { ...config, counterpart_url_prefix: '/en' };
    complete.mockResolvedValue(
      '---\nslug: club-events\n---\nSee [web dev](/web-development), [de page](/firmenfeier-planen), [external](https://example.com), [already](/en/already-prefixed).'
    );

    const { markdown } = await generateCounterpart(sourceMarkdown, keyword, prefixedConfig, dir);

    expect(markdown).toContain('[web dev](/en/web-development)');
    expect(markdown).toContain('[de page](/firmenfeier-planen)');
    expect(markdown).toContain('[external](https://example.com)');
    expect(markdown).toContain('[already](/en/already-prefixed)');
  });
});

describe('rewrite-counterpart-links', () => {
  it('rewrites a link to a known target-locale slug with the prefix', () => {
    const md = 'Read [more](/web-development) here.';
    const out = rewriteCounterpartLinks(md, { targetSlugs: ['web-development'], newSlug: 'club-events', prefix: '/en' });
    expect(out).toBe('Read [more](/en/web-development) here.');
  });

  it('rewrites a link to the newly generated slug with the prefix', () => {
    const md = 'Back to [this page](/club-events).';
    const out = rewriteCounterpartLinks(md, { targetSlugs: [], newSlug: 'club-events', prefix: '/en' });
    expect(out).toBe('Back to [this page](/en/club-events).');
  });

  it('preserves an anchor fragment on a rewritten link', () => {
    const md = '[jump](/web-development#pricing)';
    const out = rewriteCounterpartLinks(md, { targetSlugs: ['web-development'], newSlug: 'club-events', prefix: '/en' });
    expect(out).toBe('[jump](/en/web-development#pricing)');
  });

  it('leaves a DE-locale slug link unchanged', () => {
    const md = '[de link](/firmenfeier-planen)';
    const out = rewriteCounterpartLinks(md, { targetSlugs: ['web-development'], newSlug: 'club-events', prefix: '/en' });
    expect(out).toBe(md);
  });

  it('leaves an external link unchanged', () => {
    const md = '[ext](https://example.com)';
    const out = rewriteCounterpartLinks(md, { targetSlugs: ['web-development'], newSlug: 'club-events', prefix: '/en' });
    expect(out).toBe(md);
  });

  it('leaves an already-prefixed link unchanged', () => {
    const md = '[already](/en/already-prefixed)';
    const out = rewriteCounterpartLinks(md, { targetSlugs: ['already-prefixed'], newSlug: 'club-events', prefix: '/en' });
    expect(out).toBe(md);
  });

  it('is a no-op when the prefix is empty', () => {
    const md = '[link](/web-development)';
    const out = rewriteCounterpartLinks(md, { targetSlugs: ['web-development'], newSlug: 'club-events', prefix: '' });
    expect(out).toBe(md);
  });
});

describe('link-alternates', () => {
  it('inserts reciprocal alternate lines directly after each slug line', () => {
    const source = '---\nslug: firmenfeier-planen\nmeta_title: X\n---\nBody DE';
    const counterpart = '---\nslug: club-events\nmeta_title: Y\n---\nBody EN';

    const linked = linkAlternates(source, counterpart, 'firmenfeier-planen', 'club-events');

    expect(linked.sourceMarkdown).toContain('slug: firmenfeier-planen\nalternate: club-events');
    expect(linked.counterpartMarkdown).toContain('slug: club-events\nalternate: firmenfeier-planen');
  });

  it('replaces an existing alternate line instead of duplicating it', () => {
    const source = '---\nslug: firmenfeier-planen\nalternate: stale-slug\nmeta_title: X\n---\nBody';
    const counterpart = '---\nslug: club-events\n---\nBody';

    const linked = linkAlternates(source, counterpart, 'firmenfeier-planen', 'club-events');

    expect(linked.sourceMarkdown).toContain('slug: firmenfeier-planen\nalternate: club-events');
    expect(linked.sourceMarkdown.match(/alternate:/g)).toHaveLength(1);
  });
});
