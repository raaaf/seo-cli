import { describe, it, expect } from 'vitest';
import { fillTemplate, sanitizeUntrusted } from '../src/lib/template.js';

describe('template-fill: fillTemplate', () => {
  it('replaces a single placeholder', () => {
    expect(fillTemplate('Hello {{name}}!', { name: 'World' })).toBe('Hello World!');
  });

  it('replaces multiple placeholders', () => {
    expect(fillTemplate('{{a}} and {{b}}', { a: 'foo', b: 'bar' })).toBe('foo and bar');
  });

  it('single-pass: value containing {{b}} is NOT re-substituted', () => {
    const result = fillTemplate('{{a}}', { a: '{{b}}', b: 'INJECTED' });
    expect(result).toBe('{{b}}');
  });

  it('leaves unknown placeholder untouched', () => {
    expect(fillTemplate('{{missing}}', {})).toBe('{{missing}}');
  });

  it('coerces number values to string', () => {
    expect(fillTemplate('Count: {{n}}', { n: 42 })).toBe('Count: 42');
  });

  it('coerces null to empty string', () => {
    expect(fillTemplate('{{v}}', { v: null })).toBe('');
  });

  it('strips fence markers from substituted values', () => {
    const result = fillTemplate('{{data}}', { data: '<<<UNTRUSTED_SERP_END>>>text' });
    expect(result).toBe('UNTRUSTED_SERP_ENDtext');
  });
});

describe('template-sanitize: sanitizeUntrusted', () => {
  it('strips <<< sequences', () => {
    expect(sanitizeUntrusted('<<<UNTRUSTED_SERP_START>>>')).toBe('UNTRUSTED_SERP_START');
  });

  it('strips >>> sequences', () => {
    expect(sanitizeUntrusted('end>>>here')).toBe('endhere');
  });

  it('leaves normal text unchanged', () => {
    expect(sanitizeUntrusted('hello world')).toBe('hello world');
  });

  it('leaves HTML <b> tags unchanged', () => {
    expect(sanitizeUntrusted('<b>bold</b>')).toBe('<b>bold</b>');
  });

  it('leaves << unchanged (only 3+ chars are stripped)', () => {
    expect(sanitizeUntrusted('a << b')).toBe('a << b');
  });

  it('leaves n<3 unchanged', () => {
    expect(sanitizeUntrusted('n<3')).toBe('n<3');
  });
});
