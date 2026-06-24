import { describe, it, expect } from 'vitest';
import { subDays, format, isoWeek } from '../src/lib/date.js';

describe('date-helpers: subDays', () => {
  it('subtracts days without mutating the input', () => {
    const base = new Date('2026-06-24T12:00:00Z');
    const out = subDays(base, 7);
    expect(format(out)).toBe('2026-06-17');
    expect(format(base)).toBe('2026-06-24');
  });

  it('crosses a month boundary', () => {
    expect(format(subDays(new Date('2026-03-02T00:00:00Z'), 5))).toBe('2026-02-25');
  });
});

describe('date-helpers: format', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(format(new Date('2026-01-09T23:59:00Z'))).toBe('2026-01-09');
  });
});

describe('date-helpers: isoWeek', () => {
  // isoWeek normalizes via local setHours(0,0,0,0)/getDay, so feed local-constructed
  // dates to keep the assertions timezone-independent.
  it('returns YYYY-Www', () => {
    expect(isoWeek(new Date(2026, 5, 24))).toMatch(/^2026-W\d{2}$/);
  });

  it('puts 2026-01-01 (a Thursday) in week 01', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toBe('2026-W01');
  });

  it('assigns the ISO week to the correct year at year boundary', () => {
    // 2024-12-30 (Monday) belongs to ISO week 2025-W01
    expect(isoWeek(new Date(2024, 11, 30))).toBe('2025-W01');
  });
});
