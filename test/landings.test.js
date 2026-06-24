import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getExistingSlugs, getExistingTitles } from '../src/lib/landings.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-land-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeLanding(relDir, name, content) {
  const full = join(dir, relDir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, name), content, 'utf8');
}

describe('landings: getExistingSlugs', () => {
  const config = { landing_path: 'resources/landing/de/', locale: 'de' };

  it('lists .md slugs in the locale dir', () => {
    writeLanding('resources/landing/de', 'one.md', '# one');
    writeLanding('resources/landing/de', 'two.md', '# two');
    writeLanding('resources/landing/de', 'ignore.txt', 'x');
    expect(getExistingSlugs(config, dir, 'de').sort()).toEqual(['one', 'two']);
  });

  it('falls back to the default-locale dir when the requested locale dir is empty', () => {
    writeLanding('resources/landing/de', 'base.md', '# base');
    // en dir does not exist -> fall back to de
    expect(getExistingSlugs(config, dir, 'en')).toEqual(['base']);
  });

  it('returns an empty array when nothing exists', () => {
    expect(getExistingSlugs(config, dir, 'de')).toEqual([]);
  });
});

describe('landings: getExistingTitles', () => {
  it('prefers hero.headline, then title, then the filename', () => {
    writeLanding('content/landing', 'a.md', '---\nhero:\n  headline: Headline A\n---\nbody');
    writeLanding('content/landing', 'b.md', '---\ntitle: Title B\n---\nbody');
    writeLanding('content/landing', 'c.md', 'no frontmatter');
    const titles = getExistingTitles('content/landing', dir).sort();
    expect(titles).toEqual(['Headline A', 'Title B', 'c']);
  });

  it('returns an empty array when the directory is missing', () => {
    expect(getExistingTitles('does/not/exist', dir)).toEqual([]);
  });
});
