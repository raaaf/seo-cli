import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const submitSitemap = vi.fn();
vi.mock('../src/lib/gsc.js', () => ({ submitSitemap: (...a) => submitSitemap(...a) }));

const { submitSitemapCommand } = await import('../src/commands/submit-sitemap.js');

let dir, cwd, logs;
function writeConfig(yaml) { writeFileSync(join(dir, 'seo.config.yaml'), yaml, 'utf8'); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-sm-'));
  cwd = process.cwd();
  process.chdir(dir);
  logs = [];
  submitSitemap.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('submitsitemap-cmd', () => {
  it('exits 1 when gsc_property is missing', async () => {
    writeConfig('project: x\n');
    await expect(submitSitemapCommand()).rejects.toThrow('exit:1');
    expect(logs.join('\n')).toMatch(/gsc_property missing/);
  });

  it('exits 1 when base_url is missing', async () => {
    writeConfig('gsc_property: "https://x/"\n');
    await expect(submitSitemapCommand()).rejects.toThrow('exit:1');
    expect(logs.join('\n')).toMatch(/base_url missing/);
  });

  it('submits <base_url>/sitemap.xml to the property', async () => {
    writeConfig('gsc_property: "sc-domain:acme.io"\nbase_url: "https://acme.io/"\n');
    submitSitemap.mockResolvedValue(undefined);
    await submitSitemapCommand();
    expect(submitSitemap).toHaveBeenCalledWith('sc-domain:acme.io', 'https://acme.io/sitemap.xml');
    expect(logs.join('\n')).toMatch(/Sitemap submitted/);
  });

  it('prints the owner/scope hint on a 403', async () => {
    writeConfig('gsc_property: "sc-domain:acme.io"\nbase_url: "https://acme.io"\n');
    submitSitemap.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 403 }));
    await expect(submitSitemapCommand()).rejects.toThrow('exit:1');
    expect(logs.join('\n')).toMatch(/owner\/full access/);
  });
});
