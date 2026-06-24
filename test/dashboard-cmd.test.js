import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const discoverProjects = vi.fn();
const projectSummary = vi.fn();
vi.mock('../src/lib/projects.js', () => ({ discoverProjects: (...a) => discoverProjects(...a) }));
vi.mock('../src/lib/dashboard.js', () => ({ projectSummary: (...a) => projectSummary(...a) }));

const { dashboardCommand } = await import('../src/commands/dashboard.js');

const summaryFor = (p) => ({
  project: p, updated: '2026-06-01', total: 0, counts: {}, backlog: [],
  rank: null, suggestions: [], liveError: null,
});

let logs;
beforeEach(() => {
  discoverProjects.mockReset();
  projectSummary.mockReset().mockImplementation(async (p) => summaryFor(p));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
});
afterEach(() => vi.restoreAllMocks());

describe('dashboard-cmd', () => {
  it('exits 1 when no projects are found', async () => {
    discoverProjects.mockReturnValue([]);
    await expect(dashboardCommand({})).rejects.toThrow('exit:1');
  });

  it('prints aggregated JSON with --json', async () => {
    discoverProjects.mockReturnValue([
      { dir: 'alpha', name: 'Alpha', config: {} },
      { dir: 'beta', name: 'Beta', config: {} },
    ]);
    await dashboardCommand({ json: true });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.map(s => s.project.dir)).toEqual(['alpha', 'beta']);
  });

  it('renders the live-pull error in the human overview', async () => {
    discoverProjects.mockReturnValue([{ dir: 'alpha', name: 'Alpha', config: {} }]);
    projectSummary.mockImplementation(async (p) => ({ ...summaryFor(p), liveError: 'invalid_grant: token expired' }));
    await dashboardCommand({});
    expect(logs.join('\n')).toMatch(/invalid_grant: token expired/);
  });

  it('filters projects by --project before summarizing', async () => {
    discoverProjects.mockReturnValue([
      { dir: 'alpha', name: 'Alpha', config: {} },
      { dir: 'beta', name: 'Beta', config: {} },
    ]);
    await dashboardCommand({ json: true, project: 'beta' });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].project.dir).toBe('beta');
    expect(projectSummary).toHaveBeenCalledTimes(1);
  });
});
