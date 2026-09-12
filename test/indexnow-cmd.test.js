import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fetchSitemapUrls = vi.fn();
const submitIndexNow = vi.fn();
vi.mock('../src/lib/indexnow.js', () => ({
  fetchSitemapUrls: (...a) => fetchSitemapUrls(...a),
  submitIndexNow: (...a) => submitIndexNow(...a),
}));

const { indexnowCommand } = await import('../src/commands/indexnow.js');

let dir, cwd, logs;
function writeConfig(yaml) { writeFileSync(join(dir, 'seo.config.yaml'), yaml, 'utf8'); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seo-in-'));
  cwd = process.cwd();
  process.chdir(dir);
  logs = [];
  fetchSitemapUrls.mockReset();
  submitIndexNow.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('indexnow-cmd', () => {
  it('exits 1 when indexnow_key is missing', async () => {
    writeConfig('base_url: "https://acme.io"\n');
    await expect(indexnowCommand()).rejects.toThrow('exit:1');
    expect(logs.join('\n')).toMatch(/indexnow_key missing/);
  });

  it('submits all sitemap URLs and logs acceptance', async () => {
    writeConfig('base_url: "https://acme.io"\nindexnow_key: "abc123"\n');
    fetchSitemapUrls.mockResolvedValue(['https://acme.io/a', 'https://acme.io/b']);
    submitIndexNow.mockResolvedValue({ status: 202, ok: true });

    await indexnowCommand();

    expect(submitIndexNow).toHaveBeenCalledWith({
      baseUrl: 'https://acme.io',
      key: 'abc123',
      urls: ['https://acme.io/a', 'https://acme.io/b'],
    });
    expect(logs.join('\n')).toMatch(/IndexNow accepted \(202\)/);
  });

  it('logs the error and exits 1 when submission fails', async () => {
    writeConfig('base_url: "https://acme.io"\nindexnow_key: "abc123"\n');
    fetchSitemapUrls.mockResolvedValue(['https://acme.io/a']);
    submitIndexNow.mockRejectedValue(new Error('IndexNow returned 422: bad key'));

    await expect(indexnowCommand()).rejects.toThrow('exit:1');
    expect(logs.join('\n')).toMatch(/IndexNow submit failed: IndexNow returned 422/);
  });
});
