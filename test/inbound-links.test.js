import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { linkTargets, inboundLinks, topicOverlap, pickLinkSources, addRelatedPage } from '../src/lib/inbound-links.js';
import { buildInboundLinkFiles } from '../src/lib/landings.js';

const md = ({ related = [], body = 'text' } = {}) =>
  `---\nslug: x\n${related.length ? `related_pages:\n${related.map(s => `  - ${s}`).join('\n')}\n` : ''}---\n${body}`;

describe('linkTargets', () => {
  it('reads the related_pages list', () => {
    expect([...linkTargets(md({ related: ['a', 'b'] }))]).toEqual(['a', 'b']);
  });

  it('reads body links with prefix, trailing slash, anchor and query, and ignores external ones', () => {
    const body = '[a](/guides/alpha/) [b](/beta#faq) [c](/gamma?x=1) [d](https://example.com/delta) [e](//cdn.example/eps)';
    expect([...linkTargets(md({ body }))].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('inboundLinks', () => {
  it('ignores self-links and links to unknown slugs', () => {
    const pages = [
      { slug: 'a', markdown: md({ related: ['a', 'b', 'ghost'] }) },
      { slug: 'b', markdown: md() },
    ];
    const inbound = inboundLinks(pages);
    expect([...inbound.get('a')]).toEqual([]);
    expect([...inbound.get('b')]).toEqual(['a']);
    expect(inbound.has('ghost')).toBe(false);
  });
});

describe('topicOverlap', () => {
  it('matches a German compound by prefix', () => {
    expect(topicOverlap('hochzeit', 'hochzeitsplanung')).toBe(1);
  });

  it('does not prefix-match a token shorter than 5 characters', () => {
    expect(topicOverlap('web', 'webinar')).toBe(0);
  });

  it('counts each token of the first string once', () => {
    expect(topicOverlap('hochzeit', 'hochzeit hochzeitsplanung')).toBe(1);
  });
});

describe('pickLinkSources', () => {
  const target = { slug: 'hochzeit-planen', text: 'hochzeit planen checkliste' };
  const page = (slug, over = {}) => ({ slug, title: slug.replace(/-/g, ' '), markdown: md(), ...over });

  // Unrelated pages keep the site-generic filter from calling "hochzeit" generic.
  const fillers = (n = 30) => Array.from({ length: n }, (_, i) => page(`thema${i}-seite`));
  const pick = ({ pages, ...rest }) => pickLinkSources({ target, pages: [...pages, ...fillers()], ...rest }).map(p => p.slug);

  it('excludes pages that already link to the target', () => {
    const pages = [page('hochzeit-kosten', { markdown: md({ related: ['hochzeit-planen'] }) }), page('hochzeit-ablauf')];
    expect(pick({ pages })).toEqual(['hochzeit-ablauf']);
  });

  it('excludes pages whose related_pages list is full', () => {
    const full = md({ related: ['a', 'b', 'c', 'd'] });
    const pages = [page('hochzeit-kosten', { markdown: full }), page('hochzeit-ablauf')];
    expect(pick({ pages })).toEqual(['hochzeit-ablauf']);
  });

  it('never picks a page without topic overlap', () => {
    expect(pick({ pages: [page('steuer-tipps')] })).toEqual([]);
  });

  it('sorts by overlap, then fewer related entries, then slug', () => {
    const pages = [
      page('hochzeit-b'),
      page('hochzeit-a'),
      page('hochzeit-c', { markdown: md({ related: ['x'] }) }),
      page('hochzeit-planen-checkliste'),
    ];
    expect(pick({ pages, max: 10 })).toEqual(['hochzeit-planen-checkliste', 'hochzeit-a', 'hochzeit-b', 'hochzeit-c']);
  });

  it('returns at most max slugs and never the target itself', () => {
    const pages = [page('hochzeit-planen'), page('hochzeit-a'), page('hochzeit-b')];
    expect(pick({ pages, max: 1 })).toEqual(['hochzeit-a']);
  });

  it('reports the shared tokens as via', () => {
    const [first] = pickLinkSources({ target, pages: [page('hochzeit-ablauf'), ...fillers()] });
    expect(first).toEqual({ slug: 'hochzeit-ablauf', via: ['hochzeit'] });
  });

  describe('site-generic tokens', () => {
    const generic = { slug: 'taufe-organisieren', text: 'taufe organisieren' };
    const orgPages = ['festival', 'messe', 'umzug'].map(s => page(`${s}-organisieren`));

    it('a generic token alone gives no pick', () => {
      expect(pickLinkSources({ target: generic, pages: [...orgPages, ...fillers(10)] })).toEqual([]);
    });

    it('a specific shared token still picks, the generic one is not in via', () => {
      const pages = [...orgPages, page('taufe-geschenke'), ...fillers(10)];
      expect(pickLinkSources({ target: generic, pages })).toEqual([{ slug: 'taufe-geschenke', via: ['taufe'] }]);
    });

    it('counts a compound for its shorter token', () => {
      const pages = ['festival', 'messe', 'umzug'].map(s => page(`${s}-organisation`)).concat(fillers(10));
      expect(pickLinkSources({ target: { slug: 'x', text: 'organisation' }, pages })).toEqual([]);
    });

    it('is generic only above 20 percent of the pages and from 3 pages', () => {
      const three = (n) => [...orgPages, ...fillers(n)];
      // target + 3 pages hold the token: 4 of 20 is exactly 20 percent, not above
      expect(pickLinkSources({ target: generic, pages: three(16) }).map(p => p.slug).sort()).toEqual(['festival-organisieren', 'messe-organisieren', 'umzug-organisieren']);
      expect(pickLinkSources({ target: generic, pages: three(15) })).toEqual([]);
      // two pages is below the floor of 3, however small the site
      expect(pickLinkSources({ target: generic, pages: orgPages.slice(0, 1) }).map(p => p.slug)).toEqual(['festival-organisieren']);
    });
  });
});

describe('addRelatedPage', () => {
  it('appends to an existing list in its style and leaves every other byte alone', () => {
    const input = '---\nslug: x\nrelated_pages:\n- "a"\n- "b"\ntldr: keep # this\n---\n\nBody  \n';
    expect(addRelatedPage(input, 'c')).toBe('---\nslug: x\nrelated_pages:\n- "a"\n- "b"\n- "c"\ntldr: keep # this\n---\n\nBody  \n');
  });

  it('inserts a list before the closing --- when there is none', () => {
    expect(addRelatedPage('---\nslug: x\n---\nBody', 'c')).toBe('---\nslug: x\nrelated_pages:\n  - c\n---\nBody');
  });

  it('is a no-op when the slug is already listed', () => {
    const input = md({ related: ['a', 'c'] });
    expect(addRelatedPage(input, 'c')).toBe(input);
  });
});

describe('buildInboundLinkFiles', () => {
  let dir;
  const config = { landing_path: 'content/landing/de/', locale: 'de', locales: ['de'] };
  const write = (slug, markdown) => {
    mkdirSync(join(dir, 'content/landing/de'), { recursive: true });
    writeFileSync(join(dir, 'content/landing/de', `${slug}.md`), markdown);
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-inbound-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns one file entry per source even when it is picked for several targets', () => {
    write('hochzeit-ablauf', md());
    const { files, links } = buildInboundLinkFiles({
      targets: [{ slug: 'hochzeit-planen', text: 'hochzeit planen' }, { slug: 'hochzeit-kosten', text: 'hochzeit kosten' }],
      config, cwd: dir,
    });
    expect(links).toEqual([
      { source: 'hochzeit-ablauf', target: 'hochzeit-planen', via: ['hochzeit'] },
      { source: 'hochzeit-ablauf', target: 'hochzeit-kosten', via: ['hochzeit'] },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(join('content/landing/de/', 'hochzeit-ablauf.md'));
    expect(files[0].content).toContain('  - hochzeit-planen\n  - hochzeit-kosten\n');
  });

  it('never edits an excluded slug', () => {
    write('hochzeit-ablauf', md());
    const { files } = buildInboundLinkFiles({ targets: [{ slug: 'hochzeit-planen', text: 'hochzeit planen' }], config, cwd: dir, exclude: ['hochzeit-ablauf'] });
    expect(files).toEqual([]);
    expect(readFileSync(join(dir, 'content/landing/de/hochzeit-ablauf.md'), 'utf8')).toBe(md());
  });
});
