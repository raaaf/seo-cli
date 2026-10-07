import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadCatalog, resetCatalogCache, assertCatalogShape, formatCatalog, formatContract, pageRulesSection, contractOptions } from '../src/lib/catalog.js';
import { makeCatalog } from './helpers/catalog.js';

const CONFIG = { catalog_url: 'https://shop.test/seo/catalog.json' };
const okResponse = body => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => resetCatalogCache());

describe('catalog: loadCatalog', () => {
  it('returns null without catalog_url and does not fetch', async () => {
    const fetchImpl = async () => { throw new Error('must not fetch'); };
    expect(await loadCatalog({ catalog_url: null }, { fetchImpl })).toBeNull();
  });

  it('loads and returns a valid catalog', async () => {
    const catalog = makeCatalog();
    expect(await loadCatalog(CONFIG, { fetchImpl: async () => okResponse(catalog) })).toEqual(catalog);
  });

  it('fetches once per process', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return okResponse(makeCatalog()); };
    await loadCatalog(CONFIG, { fetchImpl });
    await loadCatalog(CONFIG, { fetchImpl });
    expect(calls).toBe(1);
  });

  it('throws when the shop answers with an error status', async () => {
    await expect(loadCatalog(CONFIG, { fetchImpl: async () => ({ ok: false, status: 503 }) })).rejects.toThrow(/unreachable.*503/);
  });

  it('throws when the request fails', async () => {
    await expect(loadCatalog(CONFIG, { fetchImpl: async () => { throw new Error('boom'); } })).rejects.toThrow(/unreachable.*boom/);
  });

  it('throws when the body is not JSON', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    await expect(loadCatalog(CONFIG, { fetchImpl })).rejects.toThrow(/not JSON/);
  });
});

describe('catalog: assertCatalogShape', () => {
  it('rejects a wrong version', () => {
    expect(() => assertCatalogShape(makeCatalog({ version: 2 }))).toThrow(/version must be 1/);
  });

  it('rejects missing shipping', () => {
    expect(() => assertCatalogShape(makeCatalog({ shipping: undefined }))).toThrow(/shipping/);
  });

  it('rejects a product with a non-list sizes field', () => {
    const catalog = makeCatalog();
    catalog.products[0].sizes = 'm';
    expect(() => assertCatalogShape(catalog)).toThrow(/sizes/);
  });

  it('rejects a product with a missing string field', () => {
    const catalog = makeCatalog();
    delete catalog.products[1].material;
    expect(() => assertCatalogShape(catalog)).toThrow(/needs string/);
  });

  it('rejects a category without url', () => {
    const catalog = makeCatalog({ categories: [{ key: 'a', label: 'b' }] });
    expect(() => assertCatalogShape(catalog)).toThrow(/category/);
  });
});

describe('catalog: prompt blocks', () => {
  it('formats the catalog with shipping and one line per product', () => {
    const text = formatCatalog(makeCatalog());
    expect(text).toContain('5,99 EUR');
    expect(text).toContain('delivery 5 bis 10 werktage');
    expect(text).toContain('- nachteule: nachteule (category shirts; material 100 % baumwolle; sizes s/m/l)');
    expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(5);
  });

  it('returns empty strings without catalog or contract', () => {
    expect(formatCatalog(null)).toBe('');
    expect(formatContract(null)).toBe('');
  });

  it('states every configured contract rule', () => {
    const text = formatContract({
      body_words: [300, 600], require: ['products'], forbid: ['steps'],
      products: { min: 3, max: 8, max_overlap: 0.6 }, lowercase: true,
      meta_title_suffix: ' . x', facts_denylist: ['a'],
    });
    expect(text).toContain('300 to 600 words');
    expect(text).toContain('Required frontmatter fields: products');
    expect(text).toContain('Forbidden frontmatter fields (never emit them): steps');
    expect(text).toContain('3 to 8 product slugs');
    expect(text).toContain('60 percent');
    expect(text).toContain('lowercase');
    expect(text).toContain('4 characters shorter');
    expect(text).toContain('word for word');
  });
});

describe('catalog: pageRulesSection and contractOptions', () => {
  it('is empty without contract and catalog', () => {
    expect(pageRulesSection(null, null)).toBe('');
  });

  it('adds the catalog rules even without a contract, and the contract rules even without a catalog', () => {
    expect(pageRulesSection(null, makeCatalog())).toContain('only from the product catalog');
    const withContract = pageRulesSection({ lowercase: true }, null);
    expect(withContract).toContain('lowercase');
    expect(withContract).not.toContain('product catalog');
  });

  describe('contractOptions', () => {
    let dir;
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

    it('returns nothing without a contract and reserved slugs, so validate stays unchanged', () => {
      expect(contractOptions({ landing_path: 'x/' }, makeCatalog(), '/nowhere', 'de')).toEqual({});
    });

    it('hands over the contract, catalog, reserved slugs and the products of the pages on disk', () => {
      dir = mkdtempSync(join(tmpdir(), 'seo-contract-'));
      mkdirSync(join(dir, 'landing/de'), { recursive: true });
      writeFileSync(join(dir, 'landing/de/a.md'), '---\nslug: a\nproducts: [p1, p2]\n---\nbody');
      const catalog = makeCatalog();
      const opts = contractOptions({ landing_path: 'landing/de/', locale: 'de', page_contract: { lowercase: true }, reserved_slugs: ['admin'] }, catalog, dir, 'de');
      expect(opts).toMatchObject({ contract: { lowercase: true }, catalog, reservedSlugs: ['admin'] });
      expect(opts.existingPages).toEqual([expect.objectContaining({ slug: 'a', products: ['p1', 'p2'] })]);
    });

    it('passes the catalog through with catalog_url alone, so the improve prompt gets it', () => {
      const catalog = makeCatalog();
      expect(contractOptions({ landing_path: 'x/', catalog_url: 'https://shop.test/c.json' }, catalog, '/nowhere', 'de').catalog).toBe(catalog);
      expect(contractOptions({ landing_path: 'x/', catalog_url: 'https://shop.test/c.json' }, null, '/nowhere', 'de')).toEqual({});
    });

    it('reads no pages for a project with reserved slugs only', () => {
      expect(contractOptions({ landing_path: 'x/', reserved_slugs: ['admin'] }, null, '/nowhere', 'de'))
        .toEqual({ contract: null, catalog: null, existingPages: [], reservedSlugs: ['admin'] });
    });
  });
});
