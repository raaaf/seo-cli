import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  KEYWORD_STATUS, SLUG_REGEX, isValidSlug,
  loadKeywords, saveKeywords, upsertKeyword, getPending, saveLastPR,
  KEYWORDS_FILE, LAST_PR_FILE,
} from '../src/lib/keywords.js';

describe('keywords-slug', () => {
  it('exposes a stable status enum', () => {
    expect(KEYWORD_STATUS).toMatchObject({
      PROPOSED: 'proposed', DONE: 'done', SKIP: 'skip',
      PR_OPENED: 'pr_opened', VALIDATION_FAILED: 'validation_failed',
    });
  });

  it('accepts lowercase alphanumeric/hyphen slugs starting with alnum', () => {
    expect(isValidSlug('hochzeit-planen')).toBe(true);
    expect(isValidSlug('a1')).toBe(true);
    expect(SLUG_REGEX.test('9-lives')).toBe(true);
  });

  it('rejects uppercase, leading hyphen, spaces, slashes, traversal, empty', () => {
    for (const bad of ['-foo', 'Foo', 'a b', 'a/b', '../etc', '', null, undefined, 'foo_bar']) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });
});

describe('keywords-store', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-kw-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('loadKeywords returns an empty store when the file is absent', () => {
    expect(loadKeywords(dir)).toEqual({ version: 1, keywords: [] });
  });

  it('loadKeywords throws on malformed JSON', () => {
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, KEYWORDS_FILE), '{ not json', 'utf8');
    expect(() => loadKeywords(dir)).toThrow(/Failed to parse/);
  });

  it('saveKeywords writes the store with an updated date and reloads identically', () => {
    const data = { version: 1, keywords: [{ keyword: 'a', status: 'proposed', score: 8 }] };
    saveKeywords(data, dir);
    expect(existsSync(join(dir, KEYWORDS_FILE))).toBe(true);
    const reloaded = loadKeywords(dir);
    expect(reloaded.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reloaded.keywords[0].keyword).toBe('a');
  });

  it('upsertKeyword inserts new and merges existing by keyword', () => {
    const data = { version: 1, keywords: [{ keyword: 'x', status: 'proposed', score: 5 }] };
    upsertKeyword(data, { keyword: 'y', status: 'proposed', score: 9 });
    expect(data.keywords).toHaveLength(2);
    upsertKeyword(data, { keyword: 'x', score: 7 });
    expect(data.keywords).toHaveLength(2);
    expect(data.keywords[0]).toEqual({ keyword: 'x', status: 'proposed', score: 7 });
  });

  it('getPending returns only proposed keywords at or above the cutoff', () => {
    const data = { keywords: [
      { keyword: 'a', status: 'proposed', score: 9 },
      { keyword: 'b', status: 'proposed', score: 6 },
      { keyword: 'c', status: 'done', score: 10 },
    ] };
    const pending = getPending(data, 7);
    expect(pending.map(k => k.keyword)).toEqual(['a']);
  });

  it('saveLastPR records the PR url with a timestamp', () => {
    saveLastPR('https://github.com/o/r/pull/1', dir);
    const saved = JSON.parse(readFileSync(join(dir, LAST_PR_FILE), 'utf8'));
    expect(saved.pr_url).toBe('https://github.com/o/r/pull/1');
    expect(saved.created_at).toBeTruthy();
  });
});
