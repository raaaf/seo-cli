import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { runVerify } = await import('../src/commands/verify.js');
const { replaceVerifySection, renderVerifySection } = await import('../src/steps/verify.js');

const CONFIG = 'project: acme\nrepo: acme/site\nlocale: de\nlanding_path: content/landing/de/\nsite_name: acme\nquality: strict\n';
const PAGE = [
  '---',
  'slug: stundensatz',
  '---',
  '',
  'Bei 3.500 € netto brauchst du 1.400 abrechenbare Stunden.',
  '',
  'Wiederholung: 1.400 abrechenbare Stunden.',
  '',
  'Toggl ist für fünf Nutzer kostenlos.',
].join('\n');

let cwd, deps, logs;
const write = (file, text) => { mkdirSync(join(cwd, file, '..'), { recursive: true }); writeFileSync(join(cwd, file), text); };
const read = (file) => readFileSync(join(cwd, file), 'utf8');
const FILE = 'content/landing/de/stundensatz.md';
const finding = (extra) => ({ severity: 'high', category: 'calculation', problem: 'p', source: 'https://example.test', ...extra });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'seo-verify-'));
  write('seo.config.yaml', CONFIG);
  write(FILE, PAGE);
  complete.mockReset();
  deps = { commit: vi.fn().mockResolvedValue('abc123'), writePrBody: vi.fn() };
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('patches a wrong figure, re-verifies the patched page and exits 0', async () => {
    complete
      .mockResolvedValueOnce({ findings: [finding({ quote: 'Toggl ist für fünf Nutzer kostenlos.', replacement: 'Toggl ist für drei Nutzer kostenlos.' })], statute_checks: [] })
      .mockResolvedValueOnce({ findings: [], statute_checks: [] });
    const { code, report } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(0);
    expect(report.status).toBe('patched');
    expect(read(FILE)).toContain('drei Nutzer');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('replaces a quote that recurs when the finding names one corrected value for all', async () => {
    complete
      .mockResolvedValueOnce({ findings: [finding({ quote: '1.400 abrechenbare Stunden', replacement: '1.200 abrechenbare Stunden', replace_all: true })] })
      .mockResolvedValueOnce({ findings: [] });
    const { code } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(0);
    expect(read(FILE).match(/1\.200 abrechenbare Stunden/g)).toHaveLength(2);
    expect(read(FILE)).not.toContain('1.400');
  });

  it('blocks with exit 3 when a recurring quote is not marked replace_all', async () => {
    complete.mockResolvedValue({ findings: [finding({ quote: '1.400 abrechenbare Stunden', replacement: '1.200 abrechenbare Stunden' })] });
    const { code, report } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(3);
    expect(report.status).toBe('blocked');
    expect(read(FILE)).toBe(PAGE);
  });

  it('removes a third-party price it cannot confirm instead of keeping it', async () => {
    complete
      .mockResolvedValueOnce({ findings: [finding({ category: 'price', quote: 'Toggl ist für fünf Nutzer kostenlos.', replacement: 'Welche Nutzerzahl Toggl kostenlos erlaubt, steht auf der Preisseite von Toggl.' })] })
      .mockResolvedValueOnce({ findings: [] });
    const { code } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(0);
    expect(read(FILE)).not.toContain('fünf');
  });

  it('blocks a law claim whose statute text is not quoted', async () => {
    complete.mockResolvedValue({ findings: [], statute_checks: [{ claim: 'Die Frist endet am 28. Februar.', statute_quote: '  ', source: 'https://gesetze-im-internet.de' }] });
    const { code, report } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(3);
    expect(report.pages[0].findings[0]).toMatchObject({ category: 'law', applied: false });
  });

  it('passes a law claim that quotes the statute', async () => {
    complete.mockResolvedValue({ findings: [], statute_checks: [{ claim: 'c', statute_quote: 'Der Verzicht bindet den Unternehmer mindestens fünf Kalenderjahre.', source: 's' }] });
    expect((await runVerify([FILE], {}, cwd, deps)).code).toBe(0);
  });

  it('blocks when the verifier answers twice without JSON', async () => {
    complete.mockRejectedValue(new Error('Claude returned no JSON'));
    const { code, report } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(3);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(report.pages[0].error).toMatch(/no JSON/);
  });

  it('takes the verdict from the final round: a claim the second round confirms does not block', async () => {
    complete
      .mockResolvedValueOnce({
        findings: [finding({ quote: 'Toggl ist für fünf Nutzer kostenlos.', replacement: 'Toggl ist für drei Nutzer kostenlos.' })],
        statute_checks: [{ claim: 'Die Frist endet im Februar.', statute_quote: '', source: 's' }],
      })
      .mockResolvedValueOnce({ findings: [], statute_checks: [{ claim: 'Die Frist endet im Februar.', statute_quote: 'Der Verzicht ist bis zum 28. Februar zu erklären.', source: 's' }] });
    const { code, report } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(0);
    expect(report.pages[0].findings).toHaveLength(2);
  });

  it('skips a project that is not quality: strict', async () => {
    write('seo.config.yaml', CONFIG.replace('quality: strict\n', ''));
    const { code, report } = await runVerify([FILE], {}, cwd, deps);
    expect(code).toBe(0);
    expect(report.status).toBe('skipped');
    expect(complete).not.toHaveBeenCalled();
  });

  it('skips deleted files and overlay files without calling the model', async () => {
    write('seo.config.yaml', `${CONFIG}overlays:\n  products: content/overlays/products\n`);
    write('content/overlays/products/shirt.md', '---\nmeta_title: x\n---\n');
    const { code, report } = await runVerify(['content/landing/de/gone.md', 'content/overlays/products/shirt.md', 'docs/readme.md'], {}, cwd, deps);
    expect(code).toBe(0);
    expect(report.pages).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('commits the patched files to the PR branch and reports the new head', async () => {
    complete
      .mockResolvedValueOnce({ findings: [finding({ quote: 'Toggl ist für fünf Nutzer kostenlos.', replacement: 'Toggl ist für drei Nutzer kostenlos.' })] })
      .mockResolvedValueOnce({ findings: [] });
    const { report } = await runVerify([FILE], { commit: true, branch: 'seo/new/stundensatz' }, cwd, deps);
    expect(report.head_sha).toBe('abc123');
    expect(deps.commit).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'acme/site',
      branch: 'seo/new/stundensatz',
      files: [{ path: FILE, content: expect.stringContaining('drei Nutzer') }],
    }));
    expect(logs).toContain('VERIFY_HEAD_SHA=abc123');
    expect(existsSync(join(cwd, 'seo/budget.json'))).toBe(true);
  });
});

describe('PR body section', () => {
  it('replaces the previous section on a rerun and keeps the rest of the body', () => {
    const first = renderVerifySection([{ file: 'a.md', findings: [{ applied: true, category: 'price', problem: 'old finding' }] }]);
    const body = replaceVerifySection('Intro text.\n\nFooter.', first);
    const second = renderVerifySection([{ file: 'a.md', findings: [] }]);
    const rerun = replaceVerifySection(body, second);
    expect(rerun).toContain('Intro text.');
    expect(rerun).not.toContain('old finding');
    expect(rerun.match(/<!-- seo-verify:start -->/g)).toHaveLength(1);
    expect(rerun).toContain('No findings.');
  });
});
