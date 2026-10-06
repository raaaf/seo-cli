import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';

// The spawn of `claude -p` is the I/O boundary: a fake child process replays a
// canned JSON result, the tests inspect the arguments and the environment.
const spawn = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a) => spawn(...a) }));

const { completeViaClaudeCode, ClaudeCodeError } = await import('../src/lib/claude-code.js');
const { MODELS } = await import('../src/lib/models.js');

const OK = { type: 'result', subtype: 'success', is_error: false, result: ' hello ', total_cost_usd: 0.05 };

// Replays `out` on stdout and closes with `code`. `hang` never closes.
function fakeChild(out, { code = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  child.kill = vi.fn();
  if (!hang) {
    setImmediate(() => {
      child.stdout.emit('data', typeof out === 'string' ? out : JSON.stringify(out));
      child.emit('close', code);
    });
  }
  return child;
}

const call = (extra = {}) => completeViaClaudeCode({ system: 'sys', prompt: 'hi', model: MODELS.default, maxTokens: 1234, ...extra });
const spawned = () => ({ args: spawn.mock.calls[0][1], opts: spawn.mock.calls[0][2] });
const failing = (result, extra = {}) => ({ ...OK, is_error: true, result, ...extra });

beforeEach(() => {
  spawn.mockReset();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
  process.env.ANTHROPIC_API_KEY = 'must-not-leak';
  process.env.GITHUB_TOKEN = 'must-not-leak';
  process.env.SERPAPI_KEY = 'must-not-leak';
});

describe('claude-code-backend', () => {
  it('returns trimmed text, cost and the prompt on stdin, with no tools', async () => {
    const child = fakeChild(OK);
    spawn.mockReturnValue(child);
    const res = await call();
    expect(res).toEqual({ text: 'hello', structured: null, costUsd: 0.05 });
    const { args } = spawned();
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--model', MODELS.default, '--system-prompt', 'sys', '--no-session-persistence', '--strict-mcp-config']));
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('2');
    expect(args).not.toContain('--json-schema');
    expect(child.stdin.end).toHaveBeenCalledWith('hi');
  });

  it('allows only WebSearch and maxSearches + 2 turns with web search', async () => {
    spawn.mockReturnValue(fakeChild(OK));
    await call({ webSearch: true, maxSearches: 4 });
    const { args } = spawned();
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('WebSearch');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('6');
  });

  it('passes the schema and returns structured_output', async () => {
    spawn.mockReturnValue(fakeChild({ ...OK, structured_output: { count: 3 } }));
    const schema = { type: 'object' };
    const res = await call({ schema });
    expect(res.structured).toEqual({ count: 3 });
    const { args } = spawned();
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema));
  });

  it('sets --effort high only for the generate model', async () => {
    spawn.mockReturnValue(fakeChild(OK));
    await call({ model: MODELS.generate });
    expect(spawned().args[spawned().args.indexOf('--effort') + 1]).toBe('high');
    spawn.mockReset();
    spawn.mockReturnValue(fakeChild(OK));
    await call();
    expect(spawned().args).not.toContain('--effort');
  });

  it('hands the child exactly the allowlisted environment, with maxTokens as output cap', async () => {
    spawn.mockReturnValue(fakeChild(OK));
    await call();
    const { env } = spawned().opts;
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'PATH',
    ]);
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('1234');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('runs in a fresh temp directory that is also HOME and CLAUDE_CONFIG_DIR', async () => {
    spawn.mockReturnValue(fakeChild(OK));
    await call();
    const { opts } = spawned();
    expect(opts.cwd).not.toBe(process.cwd());
    expect(opts.cwd.startsWith(tmpdir())).toBe(true);
    expect(opts.env.HOME).toBe(opts.cwd);
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe(opts.cwd);
  });

  it('maps a session limit to kind limit without family', async () => {
    spawn.mockReturnValue(fakeChild(failing("You've hit your session limit · resets 5pm")));
    await expect(call()).rejects.toMatchObject({ kind: 'limit', family: null });
  });

  it('maps an Opus limit to kind limit with family opus', async () => {
    spawn.mockReturnValue(fakeChild(failing("You've hit your Opus limit · resets 5pm")));
    await expect(call()).rejects.toMatchObject({ kind: 'limit', family: 'opus' });
  });

  it('maps an auth text to kind auth', async () => {
    spawn.mockReturnValue(fakeChild(failing('OAuth token has expired')));
    await expect(call()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps error_max_turns to kind error', async () => {
    spawn.mockReturnValue(fakeChild(failing(null, { subtype: 'error_max_turns' })));
    await expect(call()).rejects.toMatchObject({ kind: 'error' });
  });

  it('maps a non-zero exit code to kind error', async () => {
    spawn.mockReturnValue(fakeChild('boom', { code: 1 }));
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCodeError);
    expect(err.kind).toBe('error');
  });

  it('classifies a plain-text auth error on non-JSON stdout as kind auth', async () => {
    spawn.mockReturnValue(fakeChild('Not logged in · Please run /login', { code: 1 }));
    await expect(call()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps stop_reason max_tokens and refusal to kind error', async () => {
    for (const stop_reason of ['max_tokens', 'refusal']) {
      spawn.mockReturnValueOnce(fakeChild({ ...OK, stop_reason }));
      await expect(call()).rejects.toMatchObject({ kind: 'error', message: expect.stringContaining(stop_reason === 'refusal' ? 'declined' : 'max_tokens') });
    }
  });

  it('maps a schema call without structured_output to kind error', async () => {
    spawn.mockReturnValue(fakeChild(OK));
    await expect(call({ schema: { type: 'object' } })).rejects.toMatchObject({ kind: 'error' });
  });

  it('kills the child and throws kind timeout when the call hangs', async () => {
    const child = fakeChild(null, { hang: true });
    spawn.mockReturnValue(child);
    await expect(call({ timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(child.kill).toHaveBeenCalled();
  });
});
