import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { generatePage, loadIcpDoc, icpBlock } = await import('../src/steps/generate.js');

const LEAD = '## Zielgruppe (Sprachvorlage: Ton und Themen, keine Vorgaben zu Preisen oder Fakten, nie wörtlich zitieren, keine Namen)';
const config = {
  base_url: 'https://acme.io/', locale: 'de', locales: ['de'],
  site_name: 'Acme', landing_path: 'resources/landing/de/',
};
const keyword = { keyword: 'hochzeit planen', target_slug: 'hochzeit-planen', type: 'guide' };

let dir;
const writeIcp = (text, rel = 'seo/icp.md') => {
  mkdirSync(join(dir, 'seo'), { recursive: true });
  writeFileSync(join(dir, rel), text, 'utf8');
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seo-icp-')); complete.mockReset(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('icp: loadIcpDoc and icpBlock', () => {
  it('returns an empty string and an empty block without a file', () => {
    expect(loadIcpDoc(config, dir)).toBe('');
    expect(icpBlock(config, dir)).toBe('');
  });

  it('labels the document with the fixed German lead line', () => {
    writeIcp('Paare, die ihre Hochzeit selbst planen.');
    expect(icpBlock(config, dir)).toBe(`\n\n${LEAD}\nPaare, die ihre Hochzeit selbst planen.`);
  });

  it('cuts at 8000 code points, not UTF-16 units, and marks the cut', () => {
    writeIcp('😀'.repeat(8001));
    const doc = loadIcpDoc(config, dir);
    expect(doc).toBe(`${'😀'.repeat(8000)}\n[gekürzt]`);
  });

  it('does not mark a document of exactly 8000 code points', () => {
    writeIcp('😀'.repeat(8000));
    expect(loadIcpDoc(config, dir)).toBe('😀'.repeat(8000));
  });

  it('treats a read error as no document and warns once', () => {
    mkdirSync(join(dir, 'seo/icp.md'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadIcpDoc(config, dir)).toBe('');
      expect(loadIcpDoc(config, dir)).toBe('');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([null, ''])('icp_doc %j disables the feature even when the default file exists', (value) => {
    writeIcp('default doc');
    expect(loadIcpDoc({ ...config, icp_doc: value }, dir)).toBe('');
    expect(icpBlock({ ...config, icp_doc: value }, dir)).toBe('');
  });

  it('reads config.icp_doc instead of the default path', () => {
    writeIcp('default doc');
    writeIcp('custom doc', 'seo/other.md');
    expect(loadIcpDoc({ ...config, icp_doc: 'seo/other.md' }, dir)).toBe('custom doc');
  });

  it('caches per project directory, not once per process', () => {
    const other = mkdtempSync(join(tmpdir(), 'seo-icp-'));
    try {
      writeIcp('doc one');
      mkdirSync(join(other, 'seo'), { recursive: true });
      writeFileSync(join(other, 'seo/icp.md'), 'doc two');
      expect(loadIcpDoc(config, dir)).toBe('doc one');
      expect(loadIcpDoc(config, other)).toBe('doc two');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('icp: prompts stay byte-identical without a file', () => {
  it.each(['generate', 'improve', 'score', 'overlay', 'greenfield'])('%s.md holds one placeholder glued to the end of a line', (name) => {
    const tpl = readFileSync(new URL(`../src/prompts/${name}.md`, import.meta.url), 'utf8');
    expect(tpl.match(/\{\{icp\}\}/g)).toHaveLength(1);
    // Glued to non-whitespace and followed by a line break: an empty value changes nothing else.
    expect(tpl).toMatch(/\S\{\{icp\}\}\n/);
  });

  it('generate: the prompt with a file minus the block equals the prompt without a file', async () => {
    complete.mockResolvedValue('---\nslug: hochzeit-planen\n---\nbody');
    await generatePage(keyword, config, dir);
    const plain = complete.mock.calls[0][0].prompt;
    expect(plain).not.toContain('Zielgruppe');
    expect(plain).not.toContain('{{icp}}');

    const withDoc = mkdtempSync(join(tmpdir(), 'seo-icp-'));
    let block;
    try {
      mkdirSync(join(withDoc, 'seo'), { recursive: true });
      writeFileSync(join(withDoc, 'seo/icp.md'), 'Paare, die ihre Hochzeit selbst planen.');
      block = icpBlock(config, withDoc);
      await generatePage(keyword, config, withDoc);
    } finally {
      rmSync(withDoc, { recursive: true, force: true });
    }
    const filled = complete.mock.calls[1][0].prompt;
    expect(filled).toContain(`${LEAD}\nPaare, die ihre Hochzeit selbst planen.`);
    expect(filled.replace(block, '')).toBe(plain);
  });
});
