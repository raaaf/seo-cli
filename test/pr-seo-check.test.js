import { describe, it, expect } from 'vitest';
import { seoCheck } from '../src/steps/pr.js';

const page = (title, words) => ({
  markdown: `---\nmeta_title: "${title}"\nmeta_description: "x"\ntldr: "x"\nfaq:\n  - q: a\n    a: b\n---\n${'wort '.repeat(words)}\n`,
});

const shopConfig = { page_contract: { body_words: [300, 600], meta_title_suffix: ' . punkt und pause' } };

describe('PR body SEO check', () => {
  it('judges body words against the page contract instead of the 800-word default', () => {
    expect(seoCheck(page('t', 520), shopConfig)).toContain('| body words (520) | ✅ |');
    expect(seoCheck(page('t', 520), {})).toContain('| body words (520) | ❌ |');
  });

  it('counts the brand suffix the site appends when judging the meta_title length', () => {
    const title = 'geschenke für eltern mit humor und herz'; // 39 chars, 57 with the suffix
    expect(seoCheck(page(title, 520), shopConfig)).toContain(`| meta_title (${title.length} chars) | ✅ |`);
    expect(seoCheck(page(title, 520), {})).toContain(`| meta_title (${title.length} chars) | ❌ |`);
  });
});
