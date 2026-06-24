import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectProject } from '../src/lib/detect.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-detect-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel, content) {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('detect-project', () => {
  it('detects landing path, style doc, locale, clusters/CTA and a public domain', () => {
    write('resources/landing/de/page.md', '---\ncluster: hochzeit\nprimary_cta: contact\n---\nbody');
    write('docs/writing-style.md', '# style');
    mkdirSync(join(dir, 'lang/de'), { recursive: true });
    write('package.json', JSON.stringify({ homepage: 'https://acme.io/' }));

    const hints = detectProject(dir);
    expect(hints.landing_path).toBe('resources/landing/de/');
    expect(hints.style_doc).toBe('docs/writing-style.md');
    expect(hints.locale).toBe('de');
    expect(hints.clusters).toEqual(['hochzeit']);
    expect(hints.primary_cta).toBe('contact');
    expect(hints.gsc_property).toBe('https://acme.io');
    // not a git repo -> no repo hint
    expect(hints.repo).toBeUndefined();
  });

  it('ignores reserved/non-public domains', () => {
    write('package.json', JSON.stringify({ homepage: 'http://localhost:3000' }));
    write('CLAUDE.md', 'see https://app.test for the staging box');
    const hints = detectProject(dir);
    expect(hints.gsc_property).toBe(null);
  });

  it('reads APP_URL from .env.example when no other domain is found', () => {
    write('.env.example', 'APP_URL="https://shop.acme.io"\nOTHER=1');
    const hints = detectProject(dir);
    expect(hints.gsc_property).toBe('https://shop.acme.io');
  });
});
