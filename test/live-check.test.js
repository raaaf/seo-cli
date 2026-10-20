import { describe, it, expect, vi } from 'vitest';
import { waitUntilLive } from '../src/commands/live-check.js';

const config = { base_url: 'https://acme.test', landing_path: 'content/landing/de/', locale: 'de', watch: { check_deploy: true } };

describe('waitUntilLive', () => {
  it('passes at once without watch.check_deploy', async () => {
    const fetchPage = vi.fn();
    expect(await waitUntilLive({ ...config, watch: {} }, ['https://acme.test/x'], { fetchPage })).toBe(true);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('polls a new page until it stops answering 404', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 200 });
    const pause = vi.fn().mockResolvedValue();
    const live = await waitUntilLive(config, ['content/landing/de/neu.md'], { headRef: 'seo/new/neu', wait: 12, fetchPage, pause });
    expect(live).toBe(true);
    expect(fetchPage).toHaveBeenCalledWith('https://acme.test/neu', { method: 'HEAD' });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('gives up when the page stays 404 for the whole wait', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ status: 404 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await waitUntilLive(config, ['https://acme.test/x'], { wait: 0, fetchPage })).toBe(false);
  });
});
