import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSignals, saveSignals, getFresh, putSignal } from '../src/lib/signals/store.js';
import { fetchSignal } from '../src/lib/signals/index.js';

let dir;
const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-10-01T00:00:00Z');
const after = days => new Date(t0.getTime() + days * DAY);
const file = () => join(dir, 'seo', 'signals', 'x.json');

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'signals-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('signal store', () => {
  it('returns a fresh entry and drops an expired one', () => {
    putSignal('x', 'k', { a: 1 }, t0, { cwd: dir });
    expect(getFresh('x', 'k', 30, after(29), { cwd: dir })).toEqual({ a: 1 });
    expect(getFresh('x', 'k', 30, after(30), { cwd: dir })).toBeNull();
    expect(getFresh('x', 'missing', 30, t0, { cwd: dir })).toBeNull();
  });

  it('treats an entry failing validation as absent', () => {
    putSignal('x', 'k', { a: 1 }, t0, { cwd: dir });
    expect(getFresh('x', 'k', 30, t0, { cwd: dir, validate: v => v.a === 2 })).toBeNull();
  });

  it('removes entries older than twice the TTL when saving', () => {
    putSignal('x', 'old', 1, t0, { cwd: dir, ttlDays: 10 });
    putSignal('x', 'mid', 2, after(15), { cwd: dir, ttlDays: 10 });
    putSignal('x', 'new', 3, after(20), { cwd: dir, ttlDays: 10 });
    expect(Object.keys(loadSignals('x', dir).entries).sort()).toEqual(['mid', 'new']);
  });

  it('writes only when the content changed', () => {
    const store = { version: 1, entries: { k: { fetched_at: t0.toISOString(), value: 1 } } };
    expect(saveSignals('x', store, dir)).toBe(true);
    const before = statSync(file()).mtimeMs;
    expect(saveSignals('x', store, dir)).toBe(false);
    expect(statSync(file()).mtimeMs).toBe(before);
  });

  it('warns and starts empty on an unreadable file, and replaces it on the next write', () => {
    mkdirSync(join(dir, 'seo', 'signals'), { recursive: true });
    writeFileSync(file(), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadSignals('x', dir)).toEqual({ version: 1, entries: {} });
    expect(warn).toHaveBeenCalled();
    putSignal('x', 'k', 1, t0, { cwd: dir });
    expect(JSON.parse(readFileSync(file(), 'utf8')).entries.k.value).toBe(1);
  });
});

describe('fetchSignal', () => {
  it('fetches once, then serves from the cache', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const adapter = { name: 'x', ttlDays: 30, validate: () => true, fetch: vi.fn().mockResolvedValue({ n: 1 }) };
    expect(await fetchSignal(adapter, 'k')).toEqual({ n: 1 });
    expect(await fetchSignal(adapter, 'k')).toEqual({ n: 1 });
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(existsSync(file())).toBe(true);
  });

  it('still returns the fetched value when the cache write fails', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mkdirSync(join(dir, 'seo'), { recursive: true });
    writeFileSync(join(dir, 'seo', 'signals'), 'a file where the directory should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = { name: 'x', ttlDays: 30, validate: () => true, fetch: vi.fn().mockResolvedValue({ n: 1 }) };
    expect(await fetchSignal(adapter, 'k')).toEqual({ n: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it('throws adapter errors and caches nothing', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const adapter = { name: 'x', ttlDays: 30, validate: () => true, fetch: vi.fn().mockRejectedValue(new Error('boom')) };
    await expect(fetchSignal(adapter, 'k')).rejects.toThrow('boom');
    expect(existsSync(file())).toBe(false);
  });
});
