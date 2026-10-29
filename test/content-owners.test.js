import { describe, it, expect } from 'vitest';
import { contentOwnerFor } from '../src/lib/content-owners.js';

const config = { content_owners: [{ name: 'Alex', paths: ['/shop/'] }] };

describe('contentOwnerFor', () => {
  it('names the owner when every URL sits under one of their paths', () => {
    expect(contentOwnerFor(config, ['https://a.de/shop/poster'])).toBe('Alex');
    expect(contentOwnerFor(config, ['https://a.de/shop/poster?x=1', 'https://a.de/shop'])).toBe('Alex');
  });

  it('returns null for other pages, mixed URL sets, look-alike prefixes and no owners', () => {
    expect(contentOwnerFor(config, ['https://a.de/wandkalender'])).toBeNull();
    expect(contentOwnerFor(config, ['https://a.de/shop/poster', 'https://a.de/ratgeber'])).toBeNull();
    expect(contentOwnerFor(config, ['https://a.de/shopping'])).toBeNull();
    expect(contentOwnerFor(config, [])).toBeNull();
    expect(contentOwnerFor({}, ['https://a.de/shop/poster'])).toBeNull();
  });
});
