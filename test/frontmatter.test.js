import { describe, it, expect } from 'vitest';
import { splitFrontmatter, parseFrontmatter } from '../src/lib/frontmatter.js';

const DOC = `---
slug: foo
title: Bar
---
Body text here.`;

describe('frontmatter: splitFrontmatter', () => {
  it('splits frontmatter source and trimmed body', () => {
    const { fm, body, matched } = splitFrontmatter(DOC);
    expect(matched).toBe(true);
    expect(fm).toBe('slug: foo\ntitle: Bar');
    expect(body).toBe('Body text here.');
  });

  it('returns matched:false and whole input as body when no frontmatter', () => {
    const { fm, body, matched } = splitFrontmatter('no fm here');
    expect(matched).toBe(false);
    expect(fm).toBe('');
    expect(body).toBe('no fm here');
  });

  it('handles null/undefined input', () => {
    expect(splitFrontmatter(undefined)).toEqual({ fm: '', body: '', matched: false });
  });
});

describe('frontmatter: parseFrontmatter', () => {
  it('parses YAML frontmatter into an object', () => {
    const { parsed, body, matched, error } = parseFrontmatter(DOC);
    expect(matched).toBe(true);
    expect(error).toBe(null);
    expect(parsed).toEqual({ slug: 'foo', title: 'Bar' });
    expect(body).toBe('Body text here.');
  });

  it('returns empty object and matched:false when no frontmatter', () => {
    const { parsed, matched } = parseFrontmatter('plain body');
    expect(matched).toBe(false);
    expect(parsed).toEqual({});
  });

  it('surfaces a YAML parse error and returns empty parsed', () => {
    const bad = `---\nslug: "unterminated\nfoo: [1, 2\n---\nbody`;
    const { parsed, matched, error } = parseFrontmatter(bad);
    expect(matched).toBe(true);
    expect(error).toBeTruthy();
    expect(parsed).toEqual({});
  });
});
