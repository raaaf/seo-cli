import { describe, it, expect } from 'vitest';
import { linkTargets, inboundLinks, eligibleSources, addRelatedPage } from '../src/lib/inbound-links.js';

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

describe('eligibleSources', () => {
  const page = (slug, markdown = md()) => ({ slug, markdown });
  const slugs = (pages) => eligibleSources({ targetSlug: 'target', pages }).map(p => p.slug);

  it('excludes the target itself', () => {
    expect(slugs([page('target'), page('a')])).toEqual(['a']);
  });

  it('excludes pages that already link to the target, in the list or the body', () => {
    expect(slugs([page('a', md({ related: ['target'] })), page('b', md({ body: '[x](/guides/target/)' })), page('c')])).toEqual(['c']);
  });

  it('excludes pages whose related_pages list is full, but not one with room left', () => {
    expect(slugs([page('full', md({ related: ['s-a', 's-b', 's-c', 's-d'] })), page('room', md({ related: ['s-a', 's-b', 's-c'] }))])).toEqual(['room']);
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
