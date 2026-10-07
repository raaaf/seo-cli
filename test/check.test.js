import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkCommand } from '../src/commands/check.js';
import { makeValidPage } from './helpers/valid-page.js';
import { makeCatalog } from './helpers/catalog.js';

const loadCatalog = vi.fn();
vi.mock('../src/lib/catalog.js', async (orig) => ({ ...(await orig()), loadCatalog: (...a) => loadCatalog(...a) }));

const validDoc = () => makeValidPage();

let dir, cwd, logs, exitSpy;
beforeEach(() => {
  loadCatalog.mockReset();
  loadCatalog.mockResolvedValue(null);
  dir = mkdtempSync(join(tmpdir(), 'seo-check-'));
  cwd = process.cwd();
  process.chdir(dir);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function checkJson() {
  const line = logs.find(l => l.includes('SEO_CHECK_JSON='));
  return JSON.parse(line.slice(line.indexOf('SEO_CHECK_JSON=') + 'SEO_CHECK_JSON='.length));
}

describe('check-cmd', () => {
  it('exits 2 when no files are given', async () => {
    await expect(checkCommand([])).rejects.toThrow('exit:2');
  });

  it('passes a clean page and emits SEO_CHECK_JSON ok:true', async () => {
    writeFileSync(join(dir, 'webdesign-berlin.md'), validDoc(), 'utf8');
    await checkCommand(['webdesign-berlin.md']);
    const report = checkJson();
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('reports a missing file and exits 1', async () => {
    await expect(checkCommand(['nope.md'])).rejects.toThrow('exit:1');
    const report = checkJson();
    expect(report.ok).toBe(false);
    expect(report.pages[0].errors[0]).toMatch(/File not found/);
  });
});

describe('check-cmd: shop projects', () => {
  const OVERLAY_OK = [
    'meta_title: nachteule shirt fuer lange naechte',
    'meta_description: ein shirt fuer alle, die nachts erst richtig wach werden. weiche passform, ruhiges motiv, in den groessen s bis l erhaeltlich.',
    `intro: ${Array.from({ length: 60 }, (_, i) => (i % 2 ? 'shirt' : 'nachteule')).join(' ')}`,
  ].join('\n');
  const config = (extra = '') => writeFileSync(join(dir, 'seo.config.yaml'), `project: shop\nlanding_path: content/landing/de/\noverlays:\n  products: content/seo/products\n${extra}`, 'utf8');
  const overlay = (slug, fm = OVERLAY_OK) => {
    mkdirSync(join(dir, 'content/seo/products'), { recursive: true });
    writeFileSync(join(dir, 'content/seo/products', `${slug}.md`), `---\n${fm}\n---\n`, 'utf8');
    return `content/seo/products/${slug}.md`;
  };

  it('validates a landing page against the page contract', async () => {
    config('page_contract:\n  require: [products]\n');
    writeFileSync(join(dir, 'webdesign-berlin.md'), validDoc(), 'utf8');
    await expect(checkCommand(['webdesign-berlin.md'])).rejects.toThrow('exit:1');
    expect(checkJson().pages[0].errors).toContain('Missing frontmatter field: products');
  });

  it('validates an overlay file with the overlay rules, not the page rules', async () => {
    config();
    await checkCommand([overlay('nachteule')]);
    expect(checkJson()).toMatchObject({ ok: true, checked: 1 });
  });

  it('fails an overlay that breaks a rule', async () => {
    config();
    await expect(checkCommand([overlay('nachteule', 'meta_title: kurz')])).rejects.toThrow('exit:1');
    expect(checkJson().pages[0].errors).toContain('Missing overlay field: intro');
  });

  it('fails an overlay without frontmatter', async () => {
    config();
    mkdirSync(join(dir, 'content/seo/products'), { recursive: true });
    writeFileSync(join(dir, 'content/seo/products/x.md'), 'no frontmatter', 'utf8');
    await expect(checkCommand(['content/seo/products/x.md'])).rejects.toThrow('exit:1');
    expect(checkJson().pages[0].errors).toEqual(['No YAML frontmatter found']);
  });

  it('reports an orphaned overlay whose product left the catalog', async () => {
    config('catalog_url: https://shop.test/seo/catalog.json\n');
    loadCatalog.mockResolvedValue(makeCatalog());
    await expect(checkCommand([overlay('verschwunden')])).rejects.toThrow('exit:1');
    expect(checkJson().pages[0].errors).toContain('Overlay target not in the catalog: product:verschwunden');
  });

  it('passes an overlay whose product is in the catalog', async () => {
    config('catalog_url: https://shop.test/seo/catalog.json\n');
    loadCatalog.mockResolvedValue(makeCatalog());
    await checkCommand([overlay('nachteule')]);
    expect(checkJson().ok).toBe(true);
  });

  it('exits 1 with a message when the catalog is configured but unreachable', async () => {
    config('catalog_url: https://shop.test/seo/catalog.json\n');
    loadCatalog.mockRejectedValue(new Error('Catalog unreachable (https://shop.test/seo/catalog.json): HTTP 503'));
    await expect(checkCommand([overlay('nachteule')])).rejects.toThrow('exit:1');
    expect(logs.join('\n')).toMatch(/seo check: Catalog unreachable/);
  });
});
