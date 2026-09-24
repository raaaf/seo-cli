import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const complete = vi.fn();
vi.mock('../src/lib/claude.js', () => ({ complete: (...a) => complete(...a) }));

const { reviewPage, unresolvedSeverity } = await import('../src/steps/review.js');

const config = { locale: 'de', landing_path: 'content/landing/de/', site_name: 'acme' };
const keyword = { keyword: 'kleinunternehmer rechnung' };
const PAGE = [
  '---',
  'slug: kleinunternehmer-rechnung',
  '---',
  '',
  'Die Aufbewahrungsfrist beträgt 10 Jahre.',
  '',
  'Der Rest der Seite bleibt unangetastet.',
].join('\n');

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'seo-review-'));
  mkdirSync(join(cwd, 'content/landing/de'), { recursive: true });
  complete.mockReset();
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('reviewPage', () => {
  it('applies a correction whose quote appears exactly once', async () => {
    complete.mockResolvedValue({
      findings: [{
        severity: 'high',
        quote: 'Die Aufbewahrungsfrist beträgt 10 Jahre.',
        problem: 'Seit 2025 sind es 8 Jahre.',
        source: 'https://example.test/ao147',
        replacement: 'Die Aufbewahrungsfrist beträgt 8 Jahre.',
      }],
    });

    const { markdown, findings } = await reviewPage(PAGE, keyword, config, cwd);

    expect(markdown).toContain('beträgt 8 Jahre');
    expect(markdown).not.toContain('10 Jahre');
    expect(findings[0].applied).toBe(true);
    expect(unresolvedSeverity(findings)).toBeNull();
  });

  it('reports but does not apply a finding whose quote is not in the page', async () => {
    complete.mockResolvedValue({
      findings: [{
        severity: 'high',
        quote: 'ein Satz, der so nicht dasteht',
        problem: 'falsch',
        replacement: 'korrigiert',
      }],
    });

    const { markdown, findings } = await reviewPage(PAGE, keyword, config, cwd);

    expect(markdown).toBe(PAGE);
    expect(findings[0].applied).toBe(false);
    expect(unresolvedSeverity(findings)).toBe('high');
  });

  it('does not apply an ambiguous quote that occurs twice', async () => {
    const page = 'Ein Satz.\n\nEin Satz.';
    complete.mockResolvedValue({
      findings: [{ severity: 'medium', quote: 'Ein Satz.', problem: 'x', replacement: 'Ein anderer Satz.' }],
    });

    const { markdown, findings } = await reviewPage(page, keyword, config, cwd);

    expect(markdown).toBe(page);
    expect(findings[0].applied).toBe(false);
  });

  it('passes the published cluster pages to the model as context', async () => {
    writeFileSync(
      join(cwd, 'content/landing/de/stundensatz.md'),
      '---\nslug: stundensatz\nmeta_title: "Stundensatz"\ntldr: "60 bis 120 Euro pro Stunde."\n---\n\nText.',
      'utf8',
    );
    complete.mockResolvedValue({ findings: [] });

    await reviewPage(PAGE, keyword, config, cwd);

    expect(complete.mock.calls[0][0].prompt).toContain('60 bis 120 Euro pro Stunde');
    expect(complete.mock.calls[0][0].webSearch).toBe(true);
  });

  it('passes FAQ answers with numbers from published pages, not only the tldr', async () => {
    writeFileSync(
      join(cwd, 'content/landing/de/preise.md'),
      '---\nslug: preise\ntldr: "Preise haengen vom Umfang ab."\nfaq:\n  - q: "Was kostet eine Website?"\n    a: "Paket Mittel liegt bei 4.000 bis 9.000 Euro."\n  - q: "Wie lange dauert es?"\n    a: "Das kommt auf den Umfang an."\n---\n\nText.',
      'utf8',
    );
    complete.mockResolvedValue({ findings: [] });

    await reviewPage(PAGE, keyword, config, cwd);

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('4.000 bis 9.000 Euro');
    expect(prompt).not.toContain('Das kommt auf den Umfang an');
  });

  it('prioritises the most recently updated pages over alphabetical order when a cluster exceeds the slice', async () => {
    // 9 pages so the CLUSTER_PAGES=8 slice must drop one. "aaa" sorts first
    // alphabetically but is the oldest; it must be the one dropped, not
    // "iii" which is newest but sorts last.
    const slugs = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh', 'iii'];
    slugs.forEach((slug, i) => {
      const updated = `2026-01-${String(i + 1).padStart(2, '0')}`; // aaa oldest, iii newest
      writeFileSync(
        join(cwd, `content/landing/de/${slug}.md`),
        `---\nslug: ${slug}\nupdated: "${updated}"\ntldr: "tldr-${slug}"\n---\n\nText.`,
        'utf8',
      );
    });
    complete.mockResolvedValue({ findings: [] });

    await reviewPage(PAGE, keyword, config, cwd);

    const prompt = complete.mock.calls[0][0].prompt;
    expect(prompt).toContain('tldr-iii');
    expect(prompt).not.toContain('tldr-aaa');
  });

  it('returns the page unchanged when the reviewer call fails', async () => {
    complete.mockRejectedValue(new Error('overloaded'));

    const { markdown, findings } = await reviewPage(PAGE, keyword, config, cwd);

    expect(markdown).toBe(PAGE);
    expect(findings).toEqual([]);
  });

  it('includes the project style doc when config.style_doc points at a file', async () => {
    writeFileSync(join(cwd, 'style.md'), 'CANONICAL_PRICE_MARKER: 4900 EUR', 'utf8');
    complete.mockResolvedValue({ findings: [] });

    await reviewPage(PAGE, keyword, { ...config, style_doc: 'style.md' }, cwd);

    expect(complete.mock.calls[0][0].prompt).toContain('CANONICAL_PRICE_MARKER: 4900 EUR');
  });

  it('falls back to the default style doc when config.style_doc is not set', async () => {
    complete.mockResolvedValue({ findings: [] });

    await reviewPage(PAGE, keyword, config, cwd);

    const defaultStyle = readFileSync(new URL('../src/prompts/style-default.md', import.meta.url), 'utf8');
    expect(complete.mock.calls[0][0].prompt).toContain(defaultStyle.slice(0, 50));
  });

  it('ignores findings with an unknown severity', async () => {
    complete.mockResolvedValue({
      findings: [{ severity: 'critical', quote: 'Die Aufbewahrungsfrist beträgt 10 Jahre.', replacement: 'x' }],
    });

    const { markdown, findings } = await reviewPage(PAGE, keyword, config, cwd);

    expect(markdown).toBe(PAGE);
    expect(findings).toEqual([]);
  });
});
